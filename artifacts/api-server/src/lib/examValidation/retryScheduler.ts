/**
 * examValidation/retryScheduler.ts
 *
 * Global preparation scheduler — finds eligible exams and drives the
 * validation pipeline to completion.
 *
 * Phase 6 evolution (Preparation-First):
 *   - Priority ordering: oldest unfinished first (ORDER BY priority, created_at)
 *   - Throttling: configurable MAX_CONCURRENT_EXAMS per tick
 *   - Stale-job recovery: resets crashed workers before each tick
 *   - DLQ: PERMANENT_LOW_EVIDENCE questions inserted into exam_dlq
 *   - Preparation status: synced after each exam completes
 *   - Queue integration: claims/completes preparation jobs from exam_preparation_jobs
 *
 * Original behaviour preserved:
 *   - Stops on DailyQuotaExhaustedError (quota resets UTC midnight)
 *   - In-process guard prevents tick overlap
 *   - startRetryScheduler() is idempotent
 *   - 5-minute interval
 */

import { getSharedPool }                    from '../dbPool';
import { logger }                           from '../logger';
import { runValidationForExam }             from './validationPipeline';
import { DailyQuotaExhaustedError }         from './canonicalAnswerDeriver';
import {
  recoverStaleJobs,
  enqueueExam,
  getQueueOverview,
} from './preparationQueue';
import { syncPreparationStatus }            from './examPreparationStatus';

const SCHEDULER_INTERVAL_MS  = 5 * 60 * 1_000;   // 5 minutes
const MAX_CONCURRENT_EXAMS   = 10;                 // max exams processed per tick (throttle)
const BATCH_LIMIT            = 100;                // max distinct exams fetched from DB

let schedulerHandle: ReturnType<typeof setInterval> | null = null;
let running                                                  = false;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Start the global preparation / retry scheduler.
 * Idempotent — calling more than once has no effect.
 */
export function startRetryScheduler(): void {
  if (schedulerHandle !== null) return;

  logger.info(
    { intervalMs: SCHEDULER_INTERVAL_MS, maxConcurrentExams: MAX_CONCURRENT_EXAMS },
    'retryScheduler: started',
  );

  schedulerHandle = setInterval(() => {
    runRetryTick().catch((err) =>
      logger.error({ err }, 'retryScheduler: tick error'),
    );
  }, SCHEDULER_INTERVAL_MS);
}

/**
 * Stop the retry scheduler.
 * Primarily for clean shutdown in tests.
 */
export function stopRetryScheduler(): void {
  if (schedulerHandle !== null) {
    clearInterval(schedulerHandle);
    schedulerHandle = null;
    logger.info('retryScheduler: stopped');
  }
}

// ─── Internal tick ────────────────────────────────────────────────────────────

async function runRetryTick(): Promise<void> {
  if (running) {
    logger.debug('retryScheduler: previous tick still running — skipping');
    return;
  }
  running = true;

  try {
    // ── 1. Recover stale crashed workers ─────────────────────────────────────
    const recovered = await recoverStaleJobs();
    if (recovered > 0) {
      logger.info({ recovered }, 'retryScheduler: recovered stale preparation jobs');
    }

    // ── 2. Ensure any eligible exam has a preparation job ────────────────────
    await ensureQueuedForEligibleExams();

    // ── 3. Fetch eligible exams ordered by priority ───────────────────────────
    const examIds = await getExamsWithEligibleQuestions();
    if (examIds.length === 0) {
      logger.debug('retryScheduler: tick — no eligible exams');
      return;
    }

    const overview = await getQueueOverview();
    logger.info(
      { examCount: examIds.length, queue: overview },
      'retryScheduler: tick — processing eligible exams',
    );

    // ── 4. Throttled processing ───────────────────────────────────────────────
    const batch = examIds.slice(0, MAX_CONCURRENT_EXAMS);

    for (const examId of batch) {
      try {
        await runValidationForExam(examId);
        // Sync exam-level preparation_status after each exam
        await syncPreparationStatus(examId).catch((err: unknown) =>
          logger.error({ err, examId }, 'retryScheduler: syncPreparationStatus failed'),
        );
      } catch (err) {
        if (err instanceof DailyQuotaExhaustedError) {
          logger.warn(
            { examId },
            'retryScheduler: daily Gemini quota exhausted — pausing until UTC midnight reset',
          );
          return;   // stop the whole tick; other exams would fail too
        }
        logger.error({ err, examId }, 'retryScheduler: validation failed for exam');
        // continue to next exam — one failure must not block others
      }
    }

    logger.info(
      { processed: batch.length, total: examIds.length },
      'retryScheduler: tick complete',
    );
  } finally {
    running = false;
  }
}

// ─── Eligible exam query ──────────────────────────────────────────────────────

/**
 * Returns distinct exam IDs that have at least one question eligible for retry,
 * ordered by preparation job priority (oldest unfinished first).
 *
 * Uses the idx_eca_retry partial index — O(k) where k = eligible rows.
 */
async function getExamsWithEligibleQuestions(): Promise<string[]> {
  const pool = getSharedPool();
  const { rows } = await pool.query<{ exam_id: string }>(
    `SELECT DISTINCT q.exam_id
     FROM public.exam_canonical_answers ca
     INNER JOIN public.exam_questions q ON q.id = ca.question_id
     WHERE ca.validation_status IN ('PENDING', 'VALIDATED', 'LOW_EVIDENCE')
       AND ca.next_retry_at IS NOT NULL
       AND ca.next_retry_at <= now()
     ORDER BY q.exam_id
     LIMIT $1`,
    [BATCH_LIMIT],
  );
  return rows.map((r) => r.exam_id);
}

/**
 * For every exam with unready questions that has no active preparation job,
 * enqueue it with priority 1 (backlog).
 */
async function ensureQueuedForEligibleExams(): Promise<void> {
  const pool = getSharedPool();
  const { rows } = await pool.query<{ exam_id: string }>(
    `SELECT DISTINCT q.exam_id
     FROM public.exam_questions q
     LEFT JOIN public.exam_canonical_answers ca ON ca.question_id = q.id
     WHERE q.question_type IN ('mcq','true_false')
       AND (
         ca.validation_status IS NULL
         OR ca.validation_status IN ('PENDING','VALIDATED','LOW_EVIDENCE')
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.exam_preparation_jobs epj
         WHERE epj.exam_id = q.exam_id AND epj.status IN ('pending','running','paused')
       )
     LIMIT 50`,
  );

  for (const { exam_id } of rows) {
    await enqueueExam(exam_id, 1).catch((err: unknown) =>
      logger.error({ err, examId: exam_id }, 'retryScheduler: enqueue failed'),
    );
  }
}
