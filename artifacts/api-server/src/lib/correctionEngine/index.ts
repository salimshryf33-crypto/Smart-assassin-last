/**
 * correctionEngine/index.ts
 *
 * Curriculum Authority Correction Engine — orchestrator.
 *
 * Full pipeline enforced here:
 *
 *   Student Answer
 *       ↓
 *   Sage Backend (this file)
 *       ↓
 *   Stage 1: Retrieve Curriculum Evidence  (EvidenceRetriever.retrieve)
 *       ↓
 *   Stage 2: Validate Evidence             (EvidenceRetriever.validateEvidence)
 *       ↓
 *   Stage 3: Build Correction Package      (curriculumGrader: buildCorrectionPackage)
 *       ↓
 *   Stage 4: Gemini Semantic Analysis      (curriculumGrader: callGemini — evidence-only)
 *       ↓
 *   Stage 5: Backend Verification          (curriculumGrader: verifyGeminiResponse)
 *       ↓
 *   Stage 6: Final Grade                   (isCorrect = scoreRatio >= 0.5)
 *       ↓
 *   Persist + Return AttemptGradeResult
 *
 * Separation of responsibilities:
 *   CurriculumResolver  → decides WHICH curriculum to search
 *   EvidenceRetriever   → Stage 1 retrieve + Stage 2 validate
 *   DeterministicGrader → corrects MCQ/TF/exact-match (no Gemini)
 *   CurriculumGrader    → Stages 3–6 for open-ended questions
 *
 * Scoring (Phase 1.5 — partial credit):
 *   scorePct = weighted average of all scoreRatios (not binary count)
 *   isCorrect = scoreRatio >= 0.5 (binary flag for DB + flashcard generation)
 *   correctCount = count of answers where isCorrect=true (backward compat)
 *
 * Weakness Analysis integration:
 *   Answers graded as 'insufficient' (INSUFFICIENT_CURRICULUM_EVIDENCE)
 *   are persisted with gradingMethod='insufficient' and isCorrect=false.
 *   The weaknessAnalyzer filters these out — they do NOT skew weakness stats.
 */

import { examStore }              from '../examStore';
import { examSolverStore }        from '../examSolverStore';
import { logger }                 from '../logger';
import { createCurriculumResolver } from './curriculumResolver';
import { EvidenceRetriever }      from './evidenceRetriever';
import { gradeDeterministic, DETERMINISTIC_TYPES } from './deterministicGrader';
import { gradeWithOpenPackage }   from './openGrader';
import * as openPrepStore         from '../examValidation/openPreparationStore';
import { OPEN_PREPARATION_TYPES } from '../questionTypeRegistry';
import { getSharedPool }          from '../dbPool';
import type { CorrectionResult, QuestionCorrectionInput } from './types';
import type { ExamAnswer }        from '@workspace/db';

// ─── Grading Gate ─────────────────────────────────────────────────────────────
// Checks whether a question's canonical answer is READY.
// Used to exclude questions still in preparation from grading.

async function getCanonicalStatus(questionId: string): Promise<string | null> {
  const pool = getSharedPool();
  const { rows } = await pool.query<{ validation_status: string }>(
    `SELECT validation_status FROM public.exam_canonical_answers WHERE question_id = $1 LIMIT 1`,
    [questionId],
  );
  return rows[0]?.validation_status ?? null;
}

export type { CorrectionResult };

// ─── Public interface (identical to legacy AttemptGradeResult) ────────────────

export interface AttemptGradeResult {
  totalQuestions: number;
  correctCount:   number;
  /** Weighted average of scoreRatios (partial credit). */
  scorePct:       number;
  answers:        Array<ExamAnswer & { feedback: string | null }>;
}

// ─── Engine orchestrator ──────────────────────────────────────────────────────

/**
 * Grade an entire exam attempt using curriculum-authoritative correction.
 *
 * Return type is identical to the legacy gradeAttempt() so callers
 * (routes/examSolver.ts) need no changes.
 *
 * scorePct is now a weighted average of scoreRatios, enabling partial credit
 * to be reflected in the final score without any DB schema changes.
 */
export async function gradeAttemptWithCurriculum(
  attemptId: string
): Promise<AttemptGradeResult> {
  const answers = await examSolverStore.getAnswersByAttempt(attemptId);

  if (answers.length === 0) {
    return { totalQuestions: 0, correctCount: 0, scorePct: 0, answers: [] };
  }

  // ── Step 1: Resolve which curriculum to search ────────────────────────────
  const firstQ     = await examStore.getQuestionById(answers[0]!.questionId);
  const examRecord = firstQ
    ? await examStore.getExamRecord(firstQ.examId).catch(() => null)
    : null;

  const resolver   = createCurriculumResolver();
  const curriculum = examRecord
    ? await resolver.resolve({
        country:               examRecord.country,
        grade:                 examRecord.grade,
        subject:               examRecord.subject,
        curriculumDocId:       examRecord.curriculumDocId,
        linkedCurriculumDocId: (examRecord as Record<string, unknown>)['linkedCurriculumDocId'] as string | null ?? null,
      })
    : {
        strategy: 'temporary_by_subject' as const,
        filters:  { country: '', grade: '', subject: '' },
      };

  logger.info(
    {
      attemptId,
      strategy: curriculum.strategy,
      filters:  curriculum.filters,
      total:    answers.length,
    },
    'correctionEngine: starting curriculum-authoritative correction'
  );

  // ── Step 3: Grade each answer ─────────────────────────────────────────────
  let correctCount          = 0;
  let weightedScoreSum      = 0; // sum of scoreRatios for weighted scorePct
  let gradableCount         = 0; // questions that received a scoreRatio (not skipped with no answer)

  const graded: Array<ExamAnswer & { feedback: string | null }> = [];

  let aiCalls               = 0;
  let deterministicCalls    = 0;
  let insufficientEvidenceCalls = 0;
  let skippedCalls          = 0;

  for (const answer of answers) {
    // Skip already-graded answers (idempotency).
    // scoreRatio is not persisted separately — binary approximation is used here.
    // In normal flow this path is never reached (all answers start as isCorrect=null).
    // It only triggers on duplicate gradeAttemptWithCurriculum calls (edge case).
    // Note: 'insufficient' answers are NOT skipped — they are re-evaluated each run
    // so that new curriculum evidence (after linking) can produce a valid grade.
    if (answer.isCorrect !== null && answer.gradingMethod !== 'insufficient') {
      if (answer.isCorrect) correctCount++;
      // Binary approximation: partial credit not recoverable from stored data
      weightedScoreSum += answer.isCorrect ? 1.0 : 0.0;
      gradableCount++;
      graded.push({ ...answer, feedback: answer.aiFeedback ?? null });
      continue;
    }

    const question = await examStore.getQuestionById(answer.questionId);
    if (!question) {
      graded.push({ ...answer, feedback: null });
      continue;
    }

    const input: QuestionCorrectionInput = {
      questionId:    question.id,
      question:      question.question,
      questionType:  question.questionType,
      correctAnswer: question.correctAnswer  ?? null,
      options:       question.options        ?? null,
      topic:         question.topic          ?? null,
      chapter:       question.chapter        ?? null,
      subject:       question.subject,
      grade:         question.grade,
      country:       question.country,
      studentAnswer: answer.studentAnswer    ?? null,
    };

    let result: CorrectionResult;

    if (DETERMINISTIC_TYPES.has(question.questionType)) {
      // ── Grading Gate: only grade MCQ/TF if canonical answer is READY ──────
      // Preparation-First rule: no Gemini at grading time.
      // If canonical answer is not READY, mark as pending_preparation and skip.
      const canonicalStatus = await getCanonicalStatus(question.id);
      if (canonicalStatus !== 'READY') {
        logger.debug(
          { questionId: question.id, canonicalStatus },
          'correctionEngine: question not READY — marking pending_preparation',
        );
        await examSolverStore.updateAnswer(answer.id, {
          isCorrect:     null,
          gradingMethod: 'pending_preparation',
          aiFeedback:    'هذا السؤال في طور الإعداد — سيُصحح عند اكتمال التحقق من الإجابة الصحيحة',
        });
        graded.push({
          ...answer,
          isCorrect:     null,
          gradingMethod: 'pending_preparation',
          aiFeedback:    'هذا السؤال في طور الإعداد',
          feedback:      'هذا السؤال في طور الإعداد',
        });
        // Do NOT count toward correctCount or weightedScoreSum
        continue;
      }

      // ── Deterministic path (no Gemini, no network) ─────────────────────
      result = gradeDeterministic(input.studentAnswer, input.correctAnswer, input.questionType);
      deterministicCalls++;
    } else if (OPEN_PREPARATION_TYPES.has(question.questionType)) {
      // ── Open-prepared path (short_answer / calculation / essay) ────────
      // Phase 2: only grade if preparation package is READY.
      // If not ready, mark pending_preparation (same UX as MCQ gate above).
      const openPrep = await openPrepStore.getByQuestionId(question.id);

      if (openPrep?.preparationStatus === 'READY' && openPrep.package) {
        result = gradeWithOpenPackage(input, openPrep.package);
        deterministicCalls++;  // graded deterministically from stored package — no Gemini
      } else {
        logger.debug(
          { questionId: question.id, openPrepStatus: openPrep?.preparationStatus ?? 'none' },
          'correctionEngine: open question not READY — marking pending_preparation',
        );
        await examSolverStore.updateAnswer(answer.id, {
          isCorrect:     null,
          gradingMethod: 'pending_preparation',
          aiFeedback:    'هذا السؤال في طور الإعداد — سيُصحح عند اكتمال التحقق من الإجابة النموذجية',
        });
        graded.push({
          ...answer,
          isCorrect:     null,
          gradingMethod: 'pending_preparation',
          aiFeedback:    'هذا السؤال في طور الإعداد',
          feedback:      'هذا السؤال في طور الإعداد',
        });
        continue;
      }
    } else {
      // ── Unknown type — Runtime Guarantee: Gemini NEVER called at grading time ──
      // All known types (mcq, true_false, fill_in_blank, short_answer,
      // calculation, essay) are covered by DETERMINISTIC_TYPES and
      // OPEN_PREPARATION_TYPES.  If a new type is added to the registry without
      // a grading path, it lands here as a safe pending_preparation rather than
      // triggering an unintended Gemini call.
      logger.warn(
        { questionId: question.id, questionType: question.questionType },
        'correctionEngine: question type not handled by any grading path — marking pending_preparation',
      );
      await examSolverStore.updateAnswer(answer.id, {
        isCorrect:     null,
        gradingMethod: 'pending_preparation',
        aiFeedback:    'نوع هذا السؤال غير معروف — سيُصحح عند اكتمال الإعداد',
      });
      graded.push({
        ...answer,
        isCorrect:     null,
        gradingMethod: 'pending_preparation',
        aiFeedback:    'نوع السؤال غير معروف',
        feedback:      'نوع السؤال غير معروف',
      });
      continue;
    }

    // ── Accumulate weighted score ─────────────────────────────────────────
    // All questions participate in scoring including skipped (scoreRatio=0)
    weightedScoreSum += result.scoreRatio;
    gradableCount++;
    if (result.isCorrect) correctCount++;

    // ── Persist result (unchanged DB columns — zero regression) ───────────
    // gradingMethod='insufficient' allows weaknessAnalyzer to exclude these
    await examSolverStore.updateAnswer(answer.id, {
      isCorrect:     result.isCorrect,
      gradingMethod: result.gradingMethod,
      aiFeedback:    result.aiFeedback,
    });

    graded.push({
      ...answer,
      isCorrect:     result.isCorrect,
      gradingMethod: result.gradingMethod,
      aiFeedback:    result.aiFeedback,
      feedback:      result.aiFeedback,
    });
  }

  // ── Step 4: Compute weighted score (partial credit) ───────────────────────
  // scorePct reflects the weighted average of scoreRatios, not binary count.
  // pending_preparation answers are excluded from both numerator and denominator
  // so they don't drag down the score of students who answered what was available.
  const total = answers.length;
  const score = gradableCount > 0
    ? Math.round((weightedScoreSum / gradableCount) * 10_000) / 100
    : 0;

  await examSolverStore.updateAttempt(attemptId, {
    status:         'completed',
    correctCount,
    totalQuestions: total,
    scorePct:       String(score),
    completedAt:    new Date(),
  });

  logger.info(
    {
      attemptId,
      total,
      correctCount,
      scorePct:               score,
      weightedScoreSum:       weightedScoreSum.toFixed(2),
      gradableCount,
      deterministicCalls,
      aiCalls,
      insufficientEvidenceCalls,
      skippedCalls,
      strategy:               curriculum.strategy,
    },
    'correctionEngine: attempt graded with curriculum authority (partial credit active)'
  );

  return { totalQuestions: total, correctCount, scorePct: score, answers: graded };
}
