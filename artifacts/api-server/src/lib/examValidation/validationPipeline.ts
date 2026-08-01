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
import {
  deriveOpenPreparation,
  OPEN_PREP_CONFIDENCE_THRESHOLD,
}                                 from './openPreparationDeriver';
import * as openStore             from './openPreparationStore';
import * as store                 from './canonicalAnswerStore';
import { OPEN_PREPARATION_TYPES } from '../questionTypeRegistry';
import { withExamLock, updateHeartbeat } from './validationLock';
import {
  shouldGiveUp,
  computeNextRetryAt,
}                                 from './retryPolicy';
import { logAuditEvent }          from '../observability/auditLogger';
import { recordSample }           from '../observability/metricsCollector';
import { insertDLQ }              from './deadLetterQueue';
import { syncPreparationStatus }  from './examPreparationStatus';
import {
  enqueueExam,
  completeJob,
  pauseJob,
  getJobByExamId,
  updateProgress,
  HEARTBEAT_INTERVAL_MS,
}                                 from './preparationQueue';
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
    // Check both canonical-answer types (MCQ/TF) and open preparation types
    const [unreadyCanon, unreadyOpen] = await Promise.all([
      store.countUnready(record.examId),
      openStore.countUnreadyOpen(record.examId),
    ]);
    const unready = unreadyCanon + unreadyOpen;
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

  // ── Ensure a preparation job exists for this exam ─────────────────────────
  let job = await getJobByExamId(examId);
  if (!job || !['pending','running','paused'].includes(job.status)) {
    job = await enqueueExam(examId, 5);
  }
  const jobId = job.id;

  // ── Heartbeat: update every HEARTBEAT_INTERVAL_MS while pipeline runs ─────
  const heartbeatTimer = setInterval(() => {
    updateHeartbeat(jobId).catch(() => undefined);
  }, HEARTBEAT_INTERVAL_MS);

  const questions = await loadQuestions(examId);
  if (questions.length === 0) {
    logger.info({ examId }, 'validationPipeline: no questions found — skipping');
    clearInterval(heartbeatTimer);
    await completeJob(jobId, 0);
    await syncPreparationStatus(examId).catch(() => undefined);
    return;
  }

  const totalMcqQuestions = questions.filter(q => requiresCanonicalAnswer(q.questionType)).length;

  let readyCount    = 0;
  let skippedCount  = 0;
  let invalidCount  = 0;
  let lowEvidCount  = 0;
  let permLowCount  = 0;
  let geminiCalls   = 0;

  const totalOpenQuestions = questions.filter(q => OPEN_PREPARATION_TYPES.has(q.questionType)).length;
  const totalAllPreparable = totalMcqQuestions + totalOpenQuestions;

  try {
    // ── Loop 1: Canonical-answer types (MCQ / true_false / fill_in_blank) ────
    for (const question of questions) {
      // Only deterministic types need a canonical answer
      if (!requiresCanonicalAnswer(question.questionType)) {
        skippedCount++;
        continue;
      }

      const existing = await store.getByQuestionId(question.id);

      // ── Skip terminal statuses ─────────────────────────────────────────────
      if (existing?.validationStatus === 'READY') {
        readyCount++;
        skippedCount++;
        continue;
      }
      if (
        existing?.validationStatus === 'INVALID' ||
        existing?.validationStatus === 'PERMANENT_LOW_EVIDENCE'
      ) {
        skippedCount++;
        continue;
      }

      // ── Respect retry window ───────────────────────────────────────────────
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
        readyCount++;
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
        case 'PERMANENT_LOW_EVIDENCE':
          permLowCount++;
          // Insert into DLQ — fire-and-forget
          insertDLQ({
            questionId:   question.id,
            examId,
            attemptCount: updated.attemptCount,
            lastError:    updated.reasoningSummary ?? undefined,
          }).catch((err: unknown) =>
            logger.error({ err, questionId: question.id }, 'validationPipeline: DLQ insert failed'),
          );
          break;
        default:                       break;
      }

      // Update progress on the job row
      await updateProgress(jobId, readyCount, totalAllPreparable).catch(() => undefined);

      // Cooldown between Gemini calls
      if (geminiCalls > 0) {
        await sleep(INTER_QUESTION_DELAY_MS);
      }
    }

    // ── Fix 3: Pre-register all open questions as PENDING before the loop ────
    // Ensures quota-exhaustion mid-loop leaves visible PENDING records
    // instead of orphans that are invisible to the retry scheduler.
    await bulkSeedPendingOpen(examId, questions);

    // ── Loop 2: Open-preparation types (short_answer / calculation / essay) ─
    for (const question of questions) {
      if (!OPEN_PREPARATION_TYPES.has(question.questionType)) continue;

      const existing = await openStore.getByQuestionId(question.id);

      // Skip terminal statuses
      if (existing?.preparationStatus === 'READY') {
        readyCount++;
        skippedCount++;
        continue;
      }
      if (
        existing?.preparationStatus === 'INVALID' ||
        existing?.preparationStatus === 'PERMANENT_LOW_EVIDENCE'
      ) {
        skippedCount++;
        continue;
      }

      // Respect retry window
      if (existing?.nextRetryAt && existing.nextRetryAt > new Date()) {
        skippedCount++;
        continue;
      }

      // DailyQuotaExhaustedError propagates up → pauses job
      await processOpenQuestion(question, existing, geminiCalls);
      geminiCalls++;

      const updated = await openStore.getByQuestionId(question.id);
      switch (updated?.preparationStatus) {
        case 'READY':                  readyCount++;    break;
        case 'INVALID':                invalidCount++;  break;
        case 'LOW_EVIDENCE':           lowEvidCount++;  break;
        case 'PERMANENT_LOW_EVIDENCE': permLowCount++;  break;
        default:                       break;
      }

      await updateProgress(jobId, readyCount, totalAllPreparable).catch(() => undefined);

      if (geminiCalls > 0) {
        await sleep(INTER_QUESTION_DELAY_MS);
      }
    }

    // ── Mark job complete ─────────────────────────────────────────────────
    await completeJob(jobId, readyCount);

  } catch (err) {
    // On quota exhaustion: pause the job so scheduler can resume tomorrow
    if (err instanceof DailyQuotaExhaustedError) {
      await pauseJob(jobId, 'DailyQuotaExhausted').catch(() => undefined);
    }
    throw err;
  } finally {
    clearInterval(heartbeatTimer);
    // Always sync exam-level preparation_status when pipeline exits
    await syncPreparationStatus(examId).catch((syncErr: unknown) =>
      logger.error({ syncErr, examId }, 'validationPipeline: syncPreparationStatus failed'),
    );
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
  const startedAt = Date.now();

  logAuditEvent({
    examId: question.examId,
    questionId,
    event: 'validation_started',
    severity: 'info',
    payload: { attemptCount: currentAttemptCount },
  });

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
    recordSample({ validationMs: Date.now() - startedAt, outcome: 'invalid' });
    logAuditEvent({
      examId: question.examId, questionId, event: 'validation_invalid',
      severity: 'warn', durationMs: Date.now() - startedAt,
      payload: { reason: integrity.reason },
    });
    return;
  }

  // ── Stage 2: Evidence retrieval ───────────────────────────────────────────
  const retrievalStartedAt = Date.now();
  const evidence = retrieveEvidence(question);
  const retrievalMs = Date.now() - retrievalStartedAt;

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
    recordSample({ validationMs: Date.now() - startedAt, retrievalMs, outcome: giveUp ? 'invalid' : 'retry' });
    logAuditEvent({
      examId: question.examId, questionId, event: 'validation_no_evidence',
      severity: 'warn', durationMs: Date.now() - startedAt,
      payload: { finalStatus, newAttemptCount, giveUp },
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
  const geminiStartedAt = Date.now();
  let derivation;
  try {
    derivation = await deriveCanonicalAnswer(question, evidence.topChunks);
  } catch (err) {
    if (err instanceof DailyQuotaExhaustedError) throw err;  // propagate
    logger.error({ err, questionId }, 'validationPipeline: derivation error');
    derivation = null;
  }
  const geminiMs = Date.now() - geminiStartedAt;

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
    recordSample({ validationMs: Date.now() - startedAt, retrievalMs, geminiMs, outcome: giveUp ? 'invalid' : 'retry' });
    logAuditEvent({
      examId: question.examId, questionId, event: 'validation_derivation_failed',
      severity: 'warn', durationMs: Date.now() - startedAt,
      payload: { finalStatus, newAttemptCount, giveUp },
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
    recordSample({ validationMs: Date.now() - startedAt, retrievalMs, geminiMs, outcome: 'ready' });
    logAuditEvent({
      examId: question.examId, questionId, event: 'validation_ready',
      severity: 'info', durationMs: Date.now() - startedAt,
      payload: { confidence: derivation.confidence },
    });
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
    recordSample({ validationMs: Date.now() - startedAt, retrievalMs, geminiMs, outcome: giveUp ? 'invalid' : 'retry' });
    logAuditEvent({
      examId: question.examId, questionId, event: 'validation_low_confidence',
      severity: 'warn', durationMs: Date.now() - startedAt,
      payload: { confidence: derivation.confidence, finalStatus, newAttemptCount, giveUp },
    });
  }
}

// ─── Open-question processor (short_answer / calculation / essay) ─────────────

async function processOpenQuestion(
  question:    PipelineQuestion,
  existing:    openStore.OpenPreparation | null,
  _geminiCall: number,
): Promise<void> {
  const { id: questionId } = question;
  const currentAttemptCount = existing?.attemptCount ?? 0;

  // ── Stage 1: Evidence retrieval ───────────────────────────────────────────
  const evidence = retrieveEvidence(question);

  if (evidence.retrievalStatus === 'NONE') {
    const newAttemptCount = currentAttemptCount + 1;
    const giveUp          = shouldGiveUp(newAttemptCount);
    const nextRetryAt     = giveUp ? null : computeNextRetryAt(newAttemptCount);
    const finalStatus     = giveUp ? 'PERMANENT_LOW_EVIDENCE' : 'LOW_EVIDENCE';

    logger.warn(
      { questionId, questionType: question.questionType, newAttemptCount, giveUp },
      `validationPipeline(open): no evidence → ${finalStatus}`,
    );

    await openStore.upsert({
      questionId,
      examId:            question.examId,
      questionType:      question.questionType,
      preparationStatus: finalStatus as ValidationStatus,
      package:           null,
      confidence:        null,
      evidenceChunkIds:  [],
      evidencePages:     [],
      reasoningSummary:  'No curriculum evidence found',
      attemptCount:      newAttemptCount,
      lastAttemptAt:     new Date(),
      nextRetryAt,
      retrievalVersion:  1,
    });
    return;
  }

  // Record VALIDATED state with evidence before calling Gemini
  await openStore.upsert({
    questionId,
    examId:            question.examId,
    questionType:      question.questionType,
    preparationStatus: 'VALIDATED',
    package:           null,
    confidence:        null,
    evidenceChunkIds:  evidence.chunkIds,
    evidencePages:     evidence.pages,
    reasoningSummary:  null,
    attemptCount:      currentAttemptCount,
    lastAttemptAt:     existing?.lastAttemptAt ?? null,
    nextRetryAt:       existing?.nextRetryAt   ?? null,
    retrievalVersion:  1,
  });

  // ── Stage 2: Open preparation derivation (Gemini) ─────────────────────────
  let derivation;
  try {
    derivation = await deriveOpenPreparation(question, evidence.topChunks);
  } catch (err) {
    if (err instanceof DailyQuotaExhaustedError) throw err;  // propagate
    logger.error({ err, questionId }, 'validationPipeline(open): derivation error');
    derivation = null;
  }

  const newAttemptCount = currentAttemptCount + 1;

  if (!derivation) {
    const giveUp      = shouldGiveUp(newAttemptCount);
    const nextRetryAt = giveUp ? null : computeNextRetryAt(newAttemptCount);
    const finalStatus = giveUp ? 'PERMANENT_LOW_EVIDENCE' : 'LOW_EVIDENCE';

    await openStore.upsert({
      questionId,
      examId:            question.examId,
      questionType:      question.questionType,
      preparationStatus: finalStatus as ValidationStatus,
      package:           null,
      confidence:        null,
      evidenceChunkIds:  evidence.chunkIds,
      evidencePages:     evidence.pages,
      reasoningSummary:  'Gemini could not produce a parseable package',
      attemptCount:      newAttemptCount,
      lastAttemptAt:     new Date(),
      nextRetryAt,
      retrievalVersion:  1,
    });
    return;
  }

  // ── Stage 3: Confidence gate ──────────────────────────────────────────────
  const meetsThreshold = derivation.confidence >= OPEN_PREP_CONFIDENCE_THRESHOLD;

  if (meetsThreshold) {
    await openStore.upsert({
      questionId,
      examId:            question.examId,
      questionType:      question.questionType,
      preparationStatus: 'READY',
      package:           derivation.package,
      confidence:        derivation.confidence,
      evidenceChunkIds:  evidence.chunkIds,
      evidencePages:     evidence.pages,
      reasoningSummary:  derivation.reasoning,
      attemptCount:      newAttemptCount,
      lastAttemptAt:     new Date(),
      nextRetryAt:       null,
      retrievalVersion:  1,
    });
    logger.info(
      { questionId, questionType: question.questionType, confidence: derivation.confidence },
      'validationPipeline(open): question READY — package stored',
    );
  } else {
    const giveUp      = shouldGiveUp(newAttemptCount);
    const nextRetryAt = giveUp ? null : computeNextRetryAt(newAttemptCount);
    const finalStatus = giveUp ? 'PERMANENT_LOW_EVIDENCE' : 'LOW_EVIDENCE';

    await openStore.upsert({
      questionId,
      examId:            question.examId,
      questionType:      question.questionType,
      preparationStatus: finalStatus as ValidationStatus,
      package:           null,
      confidence:        derivation.confidence,
      evidenceChunkIds:  evidence.chunkIds,
      evidencePages:     evidence.pages,
      reasoningSummary:  derivation.reasoning,
      attemptCount:      newAttemptCount,
      lastAttemptAt:     new Date(),
      nextRetryAt,
      retrievalVersion:  1,
    });
    logger.warn(
      { questionId, confidence: derivation.confidence, threshold: OPEN_PREP_CONFIDENCE_THRESHOLD, finalStatus },
      `validationPipeline(open): confidence below threshold → ${finalStatus}`,
    );
  }
}

// ─── Fix 3: Bulk-seed PENDING records for open questions before the loop ──────

/**
 * Inserts a PENDING row in exam_open_preparations for every open-type question
 * in this exam that has no existing record.  Single SQL round-trip, idempotent.
 * Called at the start of Loop 2 so quota-exhaustion mid-loop leaves a visible
 * PENDING record rather than a silent orphan.
 */
async function bulkSeedPendingOpen(examId: string, questions: PipelineQuestion[]): Promise<void> {
  if (!questions.some(q => OPEN_PREPARATION_TYPES.has(q.questionType))) return;
  const pool = getSharedPool();
  await pool.query(
    `INSERT INTO public.exam_open_preparations
       (id, question_id, exam_id, question_type, preparation_status,
        evidence_chunk_ids, evidence_pages, attempt_count, retrieval_version,
        created_at, updated_at)
     SELECT gen_random_uuid(), q.id, q.exam_id, q.question_type, 'PENDING',
            '[]'::jsonb, '[]'::jsonb, 0, 1, now(), now()
     FROM public.exam_questions q
     WHERE q.exam_id = $1
       AND q.question_type IN ('short_answer', 'essay', 'calculation')
     ON CONFLICT (question_id) DO NOTHING`,
    [examId],
  );
}

// ─── Fix 4: Self-healing startup recovery ─────────────────────────────────────

/**
 * Scans for open-type questions that have no row in exam_open_preparations
 * and seeds them as PENDING.  Called once at server startup — even if a future
 * bug causes orphans to accumulate, the next restart repairs them automatically.
 *
 * Pattern: Self-Healing Recovery — used by large-scale production systems to
 * prevent anomalous states from persisting across restarts.
 */
export async function healOrphanQuestions(): Promise<void> {
  const pool = getSharedPool();
  const { rowCount } = await pool.query(
    `INSERT INTO public.exam_open_preparations
       (id, question_id, exam_id, question_type, preparation_status,
        evidence_chunk_ids, evidence_pages, attempt_count, retrieval_version,
        created_at, updated_at)
     SELECT gen_random_uuid(), q.id, q.exam_id, q.question_type, 'PENDING',
            '[]'::jsonb, '[]'::jsonb, 0, 1, now(), now()
     FROM public.exam_questions q
     LEFT JOIN public.exam_open_preparations op ON op.question_id = q.id
     WHERE op.question_id IS NULL
       AND q.question_type IN ('short_answer', 'essay', 'calculation')
     ON CONFLICT (question_id) DO NOTHING`,
  );
  const healed = rowCount ?? 0;
  if (healed > 0) {
    logger.warn(
      { healed },
      'validationPipeline: self-healing — seeded PENDING for orphan open questions',
    );
  } else {
    logger.info('validationPipeline: self-healing check — no orphan open questions');
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
