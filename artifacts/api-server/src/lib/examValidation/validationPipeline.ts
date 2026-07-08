/**
 * examValidation/validationPipeline.ts
 *
 * Orchestrates the Exam Validation Pipeline for one exam at a time.
 *
 * Pipeline per question:
 *   1. Skip if already READY (idempotent)
 *   2. Integrity check → INVALID if fails
 *   3. Evidence retrieval → LOW_EVIDENCE if insufficient
 *   4. Canonical answer derivation (Gemini) → READY or LOW_EVIDENCE
 *   5. Propagate correctOption → exam_questions.correct_answer when READY
 *
 * Design rules:
 *   - Background only — never called in request path
 *   - Idempotent — safe to run multiple times; skips completed questions
 *   - Quota-aware — stops cleanly when Gemini daily limit hit; resumes on next run
 *   - No changes to grading, OCR, chunking, or any other subsystem
 */

import { getSharedPool }        from '../dbPool';
import { logger }               from '../logger';
import { examStore }            from '../examStore';
import { checkQuestionIntegrity, requiresCanonicalAnswer } from './questionIntegrityChecker';
import { retrieveEvidence }     from './evidenceRetriever';
import { deriveCanonicalAnswer, DailyQuotaExhaustedError, CONFIDENCE_THRESHOLD } from './canonicalAnswerDeriver';
import * as store               from './canonicalAnswerStore';
import type { PipelineQuestion, ValidationStatus } from './types';

// Cooldown between consecutive Gemini calls (ms) to avoid per-minute rate limits
const INTER_QUESTION_DELAY_MS = 2_000;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Run the full validation pipeline for every question in an exam.
 *
 * Called:
 *   - Fire-and-forget after question extraction completes
 *   - On startup for exams with unvalidated questions
 *   - Via admin retry API
 *
 * Throws DailyQuotaExhaustedError if Gemini quota is exhausted mid-run
 * so the caller (startup loop) can stop processing further exams.
 */
export async function runValidationForExam(examId: string): Promise<void> {
  logger.info({ examId }, 'validationPipeline: starting');

  const questions = await loadQuestions(examId);
  if (questions.length === 0) {
    logger.info({ examId }, 'validationPipeline: no questions found — skipping');
    return;
  }

  let readyCount    = 0;
  let skippedCount  = 0;
  let invalidCount  = 0;
  let lowEvidCount  = 0;
  let geminiCalls   = 0;

  for (const question of questions) {
    // Only process question types that need a canonical answer (MCQ / true_false)
    if (!requiresCanonicalAnswer(question.questionType)) {
      skippedCount++;
      continue;
    }

    // Idempotency: skip if already READY
    const existing = await store.getByQuestionId(question.id);
    if (existing?.validationStatus === 'READY') {
      skippedCount++;
      continue;
    }

    // Also skip if correct_answer already populated from a prior run
    if (question.correctAnswer?.trim()) {
      // Ensure canonical answer record exists for consistency
      if (!existing) {
        await store.upsert({
          questionId:       question.id,
          correctOption:    question.correctAnswer,
          confidence:       null,
          reasoningSummary: 'Pre-existing correct_answer — canonical record backfilled',
          evidenceChunkIds: [],
          evidencePages:    [],
          validationStatus: 'READY',
          retrievalVersion: 1,
          verified:         false,
        });
      }
      skippedCount++;
      continue;
    }

    await processQuestion(question, geminiCalls);
    geminiCalls++;

    const updated = await store.getByQuestionId(question.id);
    switch (updated?.validationStatus) {
      case 'READY':        readyCount++;   break;
      case 'INVALID':      invalidCount++; break;
      case 'LOW_EVIDENCE': lowEvidCount++; break;
      default:             break;
    }

    // Small cooldown between Gemini calls
    if (geminiCalls > 0) {
      await sleep(INTER_QUESTION_DELAY_MS);
    }
  }

  logger.info(
    { examId, readyCount, skippedCount, invalidCount, lowEvidCount, geminiCalls },
    'validationPipeline: complete',
  );
}

/**
 * Run validation on startup for all exams that have unvalidated MCQ questions.
 * Stops cleanly on quota exhaustion (will resume on next server restart).
 */
export async function runStartupValidation(): Promise<void> {
  logger.info('validationPipeline: startup scan beginning');

  let records;
  try {
    records = await examStore.listExamRecords({ userId: '', isAdmin: true });
  } catch (err) {
    logger.error({ err }, 'validationPipeline: failed to load exam records — skipping startup');
    return;
  }

  const candidates = records.filter(
    (r) => r.extractionStatus === 'done' && (r.questionCount ?? 0) > 0,
  );

  if (candidates.length === 0) {
    logger.info('validationPipeline: no done exams with questions — nothing to validate');
    return;
  }

  logger.info({ count: candidates.length }, 'validationPipeline: startup — checking exams');

  for (const record of candidates) {
    const unready = await store.countUnready(record.examId);
    if (unready === 0) continue;

    logger.info(
      { examId: record.examId, title: record.title, unreadyQuestions: unready },
      'validationPipeline: startup — validating exam',
    );

    try {
      await runValidationForExam(record.examId);
    } catch (err) {
      if (err instanceof DailyQuotaExhaustedError) {
        logger.warn(
          { examId: record.examId },
          'validationPipeline: daily Gemini quota exhausted — pausing startup validation until tomorrow',
        );
        return;   // stop; will resume on next restart (after UTC midnight reset)
      }
      logger.error({ err, examId: record.examId }, 'validationPipeline: exam validation failed');
      // continue to next exam
    }

    // Pause between exams to avoid hammering Gemini
    await sleep(5_000);
  }

  logger.info('validationPipeline: startup scan complete');
}

// ─── Per-question processor ───────────────────────────────────────────────────

async function processQuestion(
  question:   PipelineQuestion,
  geminiCall: number,
): Promise<void> {
  const { id: questionId } = question;

  // ── Stage 1: Integrity check ──────────────────────────────────────────────
  const integrity = checkQuestionIntegrity(question);
  if (!integrity.passed) {
    logger.warn(
      { questionId, reason: integrity.reason },
      'validationPipeline: question failed integrity check → INVALID',
    );
    await store.upsert({
      questionId,
      correctOption:    null,
      confidence:       null,
      reasoningSummary: `Integrity failure: ${integrity.reason}`,
      evidenceChunkIds: [],
      evidencePages:    [],
      validationStatus: 'INVALID',
      retrievalVersion: 1,
      verified:         false,
    });
    return;
  }

  // ── Stage 2: Evidence retrieval ───────────────────────────────────────────
  const evidence = retrieveEvidence(question);

  if (evidence.retrievalStatus === 'NONE') {
    logger.warn(
      { questionId, subject: question.subject, grade: question.grade },
      'validationPipeline: no evidence found → LOW_EVIDENCE',
    );
    await store.upsert({
      questionId,
      correctOption:    null,
      confidence:       null,
      reasoningSummary: 'No curriculum evidence found for this subject/grade',
      evidenceChunkIds: [],
      evidencePages:    [],
      validationStatus: 'LOW_EVIDENCE',
      retrievalVersion: 1,
      verified:         false,
    });
    return;
  }

  // Record VALIDATED state with evidence before calling Gemini
  await store.upsert({
    questionId,
    correctOption:    null,
    confidence:       null,
    reasoningSummary: null,
    evidenceChunkIds: evidence.chunkIds,
    evidencePages:    evidence.pages,
    validationStatus: 'VALIDATED',
    retrievalVersion: 1,
    verified:         false,
  });

  if (evidence.retrievalStatus === 'LOW') {
    logger.warn(
      { questionId, chunks: evidence.topChunks.length },
      'validationPipeline: low evidence — attempting derivation anyway',
    );
  }

  // ── Stage 3: Canonical answer derivation (Gemini) ─────────────────────────
  // DailyQuotaExhaustedError propagates up to runValidationForExam → caller
  let derivation;
  try {
    derivation = await deriveCanonicalAnswer(question, evidence.topChunks);
  } catch (err) {
    if (err instanceof DailyQuotaExhaustedError) throw err;   // propagate
    logger.error({ err, questionId }, 'validationPipeline: derivation error');
    derivation = null;
  }

  if (!derivation) {
    await store.upsert({
      questionId,
      correctOption:    null,
      confidence:       null,
      reasoningSummary: 'Gemini could not produce a parseable answer',
      evidenceChunkIds: evidence.chunkIds,
      evidencePages:    evidence.pages,
      validationStatus: 'LOW_EVIDENCE',
      retrievalVersion: 1,
      verified:         false,
    });
    return;
  }

  // ── Stage 4: Confidence gate ──────────────────────────────────────────────
  const finalStatus: ValidationStatus =
    derivation.confidence >= CONFIDENCE_THRESHOLD ? 'READY' : 'LOW_EVIDENCE';

  await store.upsert({
    questionId,
    correctOption:    derivation.correctOption,
    confidence:       derivation.confidence,
    reasoningSummary: derivation.reasoning,
    evidenceChunkIds: evidence.chunkIds,
    evidencePages:    evidence.pages,
    validationStatus: finalStatus,
    retrievalVersion: 1,
    verified:         false,
  });

  // ── Stage 5: Propagate to exam_questions.correct_answer ───────────────────
  if (finalStatus === 'READY') {
    await store.populateCorrectAnswer(questionId, derivation.correctOption);
    logger.info(
      { questionId, confidence: derivation.confidence },
      'validationPipeline: question READY — correct_answer populated',
    );
  } else {
    logger.warn(
      { questionId, confidence: derivation.confidence, threshold: CONFIDENCE_THRESHOLD },
      'validationPipeline: confidence below threshold → LOW_EVIDENCE',
    );
  }
}

// ─── Load questions via raw SQL ───────────────────────────────────────────────
// Avoids importing from @workspace/db — keeps module self-contained.

async function loadQuestions(examId: string): Promise<PipelineQuestion[]> {
  const pool = getSharedPool();
  const { rows } = await pool.query<{
    id:            string;
    exam_id:       string;
    question:      string;
    question_type: string;
    options:       unknown;
    correct_answer:string | null;
    subject:       string;
    grade:         string;
    country:       string;
    topic:         string | null;
    chapter:       string | null;
  }>(
    `SELECT id, exam_id, question, question_type, options, correct_answer,
            subject, grade, country, topic, chapter
     FROM public.exam_questions
     WHERE exam_id = $1
     ORDER BY question_order`,
    [examId],
  );
  return rows.map((r) => ({
    id:           r.id,
    examId:       r.exam_id,
    question:     r.question,
    questionType: r.question_type,
    options:      r.options,
    correctAnswer:r.correct_answer,
    subject:      r.subject,
    grade:        r.grade,
    country:      r.country,
    topic:        r.topic,
    chapter:      r.chapter,
  }));
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
