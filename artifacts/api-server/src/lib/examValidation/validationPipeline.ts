/**
 * examValidation/validationPipeline.ts
 *
 * Orchestrates the Exam Validation Pipeline for one exam at a time.
 *
 * Pipeline per question:
 *   0. Skip if READY / INVALID / PERMANENT_LOW_EVIDENCE  (terminal states)
 *   1. Skip if next_retry_at is in the future            (wait for scheduler)
 *   2. Integrity check  → INVALID if fails
 *   3. Evidence retrieval → LOW_EVIDENCE / PERMANENT_LOW_EVIDENCE if no chunks
 *   4. Canonical answer derivation (Gemini)
 *   5. Confidence gate  → READY or LOW_EVIDENCE / PERMANENT_LOW_EVIDENCE
 *   6. Propagate correctOption → exam_questions.correct_answer when READY
 *
 * Phase 3 additions:
 *   - PostgreSQL advisory lock (withExamLock) — only one worker per exam
 *   - attempt_count, last_attempt_at, next_retry_at tracked in every upsert
 *   - Exponential retry schedule (retryPolicy) for LOW_EVIDENCE questions
 *   - PERMANENT_LOW_EVIDENCE after MAX_VALIDATION_ATTEMPTS exhausted
 *   - next_retry_at respected: questions with a future window are skipped
 *
 * Design rules:
 *   - Background only — never called in request path
 *   - Idempotent — safe to run multiple times; skips completed questions
 *   - Quota-aware — stops cleanly when Gemini daily limit hit; resumes on next run
 *   - No changes to grading, OCR, chunking, or any other subsystem
 */

import { getSharedPool }          from '../dbPool';
import { logger }                 from '../logger';
import { examStore }              from '../examStore';
import { checkQuestionIntegrity, requiresCanonicalAnswer } from './questionIntegrityChecker';
import { retrieveEvidence }       from './evidenceRetriever';
import {
  deriveCanonicalAnswer,
  DailyQuotaExhaustedError,
  CONFIDENCE_THRESHOLD,
}                                 from './canonicalAnswerDeriver';
import * as store                 from './canonicalAnswerStore';
import { withExamLock }           from './validationLock';
import {
  shouldGiveUp,
  computeNextRetryAt,
}                                 from './retryPolicy';
import type {
  PipelineQuestion,
  ValidationStatus,
  CanonicalAnswer,
}                                 from './types';

// Cooldown between consecutive Gemini calls (ms) to avoid per-minute rate limits
const INTER_QUESTION_DELAY_MS = 2_000;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Run the full validation pipeline for every question in an exam.
 *
 * Wrapped in a PostgreSQL advisory lock — if another worker (or another
 * scheduler tick) is already validating this exam the call returns immediately.
 *
 * Throws DailyQuotaExhaustedError if Gemini quota is exhausted mid-run so
 * the caller (startup loop / scheduler) can stop processing further exams.
 */
export async function runValidationForExam(examId: string): Promise<void> {
  const { acquired } = await withExamLock(examId, () => _runValidation(examId));
  if (!acquired) {
    logger.info(
      { examId },
      'validationPipeline: skipped — another worker already holds the lock',
    );
  }
}

/**
 * Run validation on startup for all exams that have questions still eligible
 * for (re-)validation.  Stops cleanly on quota exhaustion.
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
    // countUnready respects retry windows and excludes terminal statuses
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
        return;   // stop; will resume on next restart after UTC midnight reset
      }
      logger.error({ err, examId: record.examId }, 'validationPipeline: exam validation failed');
      // continue to next exam
    }

    // Pause between exams to avoid hammering Gemini
    await sleep(5_000);
  }

  logger.info('validationPipeline: startup scan complete');
}

// ─── Internal pipeline (runs inside advisory lock) ────────────────────────────

async function _runValidation(examId: string): Promise<void> {
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
  let permLowCount  = 0;
  let geminiCalls   = 0;

  for (const question of questions) {
    // Only MCQ / true_false need a canonical answer
    if (!requiresCanonicalAnswer(question.questionType)) {
      skippedCount++;
      continue;
    }

    const existing = await store.getByQuestionId(question.id);

    // ── Skip terminal statuses ─────────────────────────────────────────────
    if (
      existing?.validationStatus === 'READY' ||
      existing?.validationStatus === 'INVALID' ||
      existing?.validationStatus === 'PERMANENT_LOW_EVIDENCE'
    ) {
      skippedCount++;
      continue;
    }

    // ── Respect retry window ───────────────────────────────────────────────
    // Questions with a future next_retry_at are handled by the retry scheduler.
    if (existing?.nextRetryAt && existing.nextRetryAt > new Date()) {
      skippedCount++;
      continue;
    }

    // ── Backfill: existing correct_answer from prior extraction ───────────
    if (question.correctAnswer?.trim()) {
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
          attemptCount:     0,
          lastAttemptAt:    null,
          nextRetryAt:      null,
          verified:         false,
        });
      }
      skippedCount++;
      continue;
    }

    // ── Process this question ─────────────────────────────────────────────
    // DailyQuotaExhaustedError propagates to the advisory-lock wrapper → caller
    await processQuestion(question, existing, geminiCalls);
    geminiCalls++;

    const updated = await store.getByQuestionId(question.id);
    switch (updated?.validationStatus) {
      case 'READY':                  readyCount++;    break;
      case 'INVALID':                invalidCount++;  break;
      case 'LOW_EVIDENCE':           lowEvidCount++;  break;
      case 'PERMANENT_LOW_EVIDENCE': permLowCount++;  break;
      default:                       break;
    }

    // Cooldown between Gemini calls
    if (geminiCalls > 0) {
      await sleep(INTER_QUESTION_DELAY_MS);
    }
  }

  logger.info(
    {
      examId,
      readyCount,
      skippedCount,
      invalidCount,
      lowEvidCount,
      permLowCount,
      geminiCalls,
    },
    'validationPipeline: complete',
  );
}

// ─── Per-question processor ───────────────────────────────────────────────────

async function processQuestion(
  question:   PipelineQuestion,
  existing:   CanonicalAnswer | null,
  _geminiCall:number,              // kept for future per-question logging
): Promise<void> {
  const { id: questionId }  = question;
  const currentAttemptCount = existing?.attemptCount ?? 0;

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
      // INVALID is permanent; no attempt tracking needed
      attemptCount:     currentAttemptCount,
      lastAttemptAt:    new Date(),
      nextRetryAt:      null,
      verified:         false,
    });
    return;
  }

  // ── Stage 2: Evidence retrieval ───────────────────────────────────────────
  const evidence = retrieveEvidence(question);

  if (evidence.retrievalStatus === 'NONE') {
    const newAttemptCount = currentAttemptCount + 1;
    const giveUp          = shouldGiveUp(newAttemptCount);
    const nextRetryAt     = giveUp ? null : computeNextRetryAt(newAttemptCount);
    const finalStatus: ValidationStatus = giveUp
      ? 'PERMANENT_LOW_EVIDENCE'
      : 'LOW_EVIDENCE';

    logger.warn(
      { questionId, subject: question.subject, grade: question.grade, newAttemptCount, giveUp },
      `validationPipeline: no evidence found → ${finalStatus}`,
    );
    await store.upsert({
      questionId,
      correctOption:    null,
      confidence:       null,
      reasoningSummary: 'No curriculum evidence found for this subject/grade',
      evidenceChunkIds: [],
      evidencePages:    [],
      validationStatus: finalStatus,
      retrievalVersion: 1,
      attemptCount:     newAttemptCount,
      lastAttemptAt:    new Date(),
      nextRetryAt,
      verified:         false,
    });
    return;
  }

  // Record VALIDATED state with evidence BEFORE calling Gemini.
  // attempt_count is NOT incremented here — the attempt hasn't happened yet.
  await store.upsert({
    questionId,
    correctOption:    null,
    confidence:       null,
    reasoningSummary: null,
    evidenceChunkIds: evidence.chunkIds,
    evidencePages:    evidence.pages,
    validationStatus: 'VALIDATED',
    retrievalVersion: 1,
    attemptCount:     currentAttemptCount,
    lastAttemptAt:    existing?.lastAttemptAt ?? null,
    nextRetryAt:      existing?.nextRetryAt   ?? null,
    verified:         false,
  });

  if (evidence.retrievalStatus === 'LOW') {
    logger.warn(
      { questionId, chunks: evidence.topChunks.length },
      'validationPipeline: low evidence — attempting derivation anyway',
    );
  }

  // ── Stage 3: Canonical answer derivation (Gemini) ─────────────────────────
  // DailyQuotaExhaustedError propagates up through withExamLock → caller
  let derivation;
  try {
    derivation = await deriveCanonicalAnswer(question, evidence.topChunks);
  } catch (err) {
    if (err instanceof DailyQuotaExhaustedError) throw err;  // propagate
    logger.error({ err, questionId }, 'validationPipeline: derivation error');
    derivation = null;
  }

  // Gemini was called — now increment attempt_count
  const newAttemptCount = currentAttemptCount + 1;

  if (!derivation) {
    const giveUp      = shouldGiveUp(newAttemptCount);
    const nextRetryAt = giveUp ? null : computeNextRetryAt(newAttemptCount);
    const finalStatus: ValidationStatus = giveUp
      ? 'PERMANENT_LOW_EVIDENCE'
      : 'LOW_EVIDENCE';

    await store.upsert({
      questionId,
      correctOption:    null,
      confidence:       null,
      reasoningSummary: 'Gemini could not produce a parseable answer',
      evidenceChunkIds: evidence.chunkIds,
      evidencePages:    evidence.pages,
      validationStatus: finalStatus,
      retrievalVersion: 1,
      attemptCount:     newAttemptCount,
      lastAttemptAt:    new Date(),
      nextRetryAt,
      verified:         false,
    });
    return;
  }

  // ── Stage 4: Confidence gate ──────────────────────────────────────────────
  const meetsThreshold = derivation.confidence >= CONFIDENCE_THRESHOLD;

  if (meetsThreshold) {
    await store.upsert({
      questionId,
      correctOption:    derivation.correctOption,
      confidence:       derivation.confidence,
      reasoningSummary: derivation.reasoning,
      evidenceChunkIds: evidence.chunkIds,
      evidencePages:    evidence.pages,
      validationStatus: 'READY',
      retrievalVersion: 1,
      attemptCount:     newAttemptCount,
      lastAttemptAt:    new Date(),
      nextRetryAt:      null,    // done — no further retries
      verified:         false,
    });

    // ── Stage 5: Propagate to exam_questions.correct_answer ────────────────
    await store.populateCorrectAnswer(questionId, derivation.correctOption);
    logger.info(
      { questionId, confidence: derivation.confidence },
      'validationPipeline: question READY — correct_answer populated',
    );
  } else {
    const giveUp      = shouldGiveUp(newAttemptCount);
    const nextRetryAt = giveUp ? null : computeNextRetryAt(newAttemptCount);
    const finalStatus: ValidationStatus = giveUp
      ? 'PERMANENT_LOW_EVIDENCE'
      : 'LOW_EVIDENCE';

    await store.upsert({
      questionId,
      correctOption:    derivation.correctOption,
      confidence:       derivation.confidence,
      reasoningSummary: derivation.reasoning,
      evidenceChunkIds: evidence.chunkIds,
      evidencePages:    evidence.pages,
      validationStatus: finalStatus,
      retrievalVersion: 1,
      attemptCount:     newAttemptCount,
      lastAttemptAt:    new Date(),
      nextRetryAt,
      verified:         false,
    });

    logger.warn(
      {
        questionId,
        confidence: derivation.confidence,
        threshold:  CONFIDENCE_THRESHOLD,
        newAttemptCount,
        finalStatus,
        nextRetryAt,
      },
      `validationPipeline: confidence below threshold → ${finalStatus}`,
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
