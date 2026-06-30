/**
 * correctionEngine/index.ts
 *
 * Curriculum Authority Correction Engine — orchestrator.
 *
 * Responsibilities (this file): wire all layers together and expose
 * gradeAttemptWithCurriculum() as a drop-in replacement for the old
 * gradeAttempt() internals.
 *
 * Separation of responsibilities enforced here:
 *   CurriculumResolver  → decides WHICH curriculum to search
 *   EvidenceRetriever   → retrieves curriculum evidence (RAG)
 *   DeterministicGrader → corrects MCQ/TF/exact-match (no Gemini)
 *   CurriculumGrader    → corrects open-ended (Gemini + evidence only)
 *
 * Pipeline for every student answer after "Finish Exam":
 *
 *   Exam record → CurriculumResolver → ResolvedCurriculum
 *       ↓
 *   For each question:
 *       deterministic? → gradeDeterministic()    (no network)
 *       open-ended?    → EvidenceRetriever.retrieve()
 *                        → EvidenceRetriever.isSufficient()?
 *                            YES → gradeWithCurriculum()  (Gemini + evidence)
 *                            NO  → INSUFFICIENT_CURRICULUM_EVIDENCE
 *       ↓
 *   Persist isCorrect + gradingMethod + aiFeedback (unchanged DB schema)
 *       ↓
 *   Return AttemptGradeResult (identical interface to legacy gradeAttempt)
 */

import { examStore }              from '../examStore';
import { examSolverStore }        from '../examSolverStore';
import { logger }                 from '../logger';
import { createCurriculumResolver } from './curriculumResolver';
import { EvidenceRetriever }      from './evidenceRetriever';
import { gradeDeterministic, DETERMINISTIC_TYPES } from './deterministicGrader';
import { gradeWithCurriculum }    from './curriculumGrader';
import type { CorrectionResult, QuestionCorrectionInput } from './types';
import type { ExamAnswer }        from '@workspace/db';

export type { CorrectionResult };

// ─── Public interface (identical to legacy AttemptGradeResult) ────────────────

export interface AttemptGradeResult {
  totalQuestions: number;
  correctCount:   number;
  scorePct:       number;
  answers:        Array<ExamAnswer & { feedback: string | null }>;
}

// ─── Engine orchestrator ──────────────────────────────────────────────────────

/**
 * Grade an entire exam attempt using curriculum-authoritative correction.
 *
 * Return type is identical to the legacy gradeAttempt() so callers
 * (routes/examSolver.ts) need no changes.
 */
export async function gradeAttemptWithCurriculum(
  attemptId: string
): Promise<AttemptGradeResult> {
  const answers = await examSolverStore.getAnswersByAttempt(attemptId);

  if (answers.length === 0) {
    return { totalQuestions: 0, correctCount: 0, scorePct: 0, answers: [] };
  }

  // ── Step 1: Resolve which curriculum to search ────────────────────────────
  // Look up the exam record via the first answer's question
  const firstQ     = await examStore.getQuestionById(answers[0]!.questionId);
  const examRecord = firstQ
    ? await examStore.getExamRecord(firstQ.examId).catch(() => null)
    : null;

  const resolver   = createCurriculumResolver();
  const curriculum = examRecord
    ? await resolver.resolve({
        country:         examRecord.country,
        grade:           examRecord.grade,
        subject:         examRecord.subject,
        curriculumDocId: examRecord.curriculumDocId,
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

  // ── Step 2: Per-attempt evidence cache ───────────────────────────────────
  // One retriever per gradeAttemptWithCurriculum() call — caches evidence
  // so questions with the same topic/chapter share the same RAG results.
  const retriever = new EvidenceRetriever();

  // ── Step 3: Grade each answer ─────────────────────────────────────────────
  let correctCount = 0;
  const graded: Array<ExamAnswer & { feedback: string | null }> = [];

  let aiCalls = 0;
  let deterministicCalls = 0;
  let insufficientEvidenceCalls = 0;
  let skippedCalls = 0;

  for (const answer of answers) {
    // Skip already-graded answers (idempotency)
    if (answer.isCorrect !== null) {
      if (answer.isCorrect) correctCount++;
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
      // ── Deterministic path (no Gemini, no network) ─────────────────────
      result = gradeDeterministic(input.studentAnswer, input.correctAnswer, input.questionType);
      deterministicCalls++;
    } else {
      // ── Curriculum-grounded path ────────────────────────────────────────
      const evidence = await retriever.retrieve(input, curriculum);
      result         = await gradeWithCurriculum(input, evidence);

      if (result.evidenceStatus === 'INSUFFICIENT_CURRICULUM_EVIDENCE') {
        insufficientEvidenceCalls++;
      } else if (result.evidenceStatus === 'SKIPPED') {
        skippedCalls++;
      } else {
        aiCalls++;
      }
    }

    // Persist result (unchanged DB columns — zero regression)
    await examSolverStore.updateAnswer(answer.id, {
      isCorrect:     result.isCorrect,
      gradingMethod: result.gradingMethod,
      aiFeedback:    result.aiFeedback,
    });

    if (result.isCorrect) correctCount++;
    graded.push({
      ...answer,
      isCorrect:     result.isCorrect,
      gradingMethod: result.gradingMethod,
      aiFeedback:    result.aiFeedback,
      feedback:      result.aiFeedback,
    });
  }

  // ── Step 4: Finalise attempt ──────────────────────────────────────────────
  const total = answers.length;
  const score = total > 0
    ? Math.round((correctCount / total) * 10_000) / 100
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
      deterministicCalls,
      aiCalls,
      insufficientEvidenceCalls,
      skippedCalls,
      strategy:               curriculum.strategy,
    },
    'correctionEngine: attempt graded with curriculum authority'
  );

  return { totalQuestions: total, correctCount, scorePct: score, answers: graded };
}
