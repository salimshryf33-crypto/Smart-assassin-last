/**
 * examValidation/retryScheduler.ts
 *
 * Periodic scheduler that finds LOW_EVIDENCE / PENDING / VALIDATED questions
 * whose next_retry_at window has elapsed and re-runs the validation pipeline.
 *
 * Design:
 *   - Queries ONLY rows with next_retry_at <= now() via the idx_eca_retry
 *     partial index — no full-table scans, scales to millions of rows.
 *   - Groups eligible questions by exam_id; validates one exam at a time.
 *   - Stops immediately on DailyQuotaExhaustedError (quota resets at UTC midnight).
 *   - In-process guard (running flag) prevents tick overlap.
 *   - startRetryScheduler() is idempotent — calling it twice is a no-op.
 *
 * Scheduler interval: every 5 minutes.
 * Batch cap: 100 distinct exams per tick (prevents unbounded memory usage).
 */

import { getSharedPool }        from '../dbPool';
import { logger }               from '../logger';
import { runValidationForExam } from './validationPipeline';
import { DailyQuotaExhaustedError } from './canonicalAnswerDeriver';

const SCHEDULER_INTERVAL_MS = 5 * 60 * 1_000;   // 5 minutes
const BATCH_LIMIT            = 100;               // max distinct exams per tick

let schedulerHandle: ReturnType<typeof setInterval> | null = null;
let running                                                  = false;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Start the retry scheduler.
 * Idempotent — calling more than once has no effect.
 */
export function startRetryScheduler(): void {
  if (schedulerHandle !== null) return;

  logger.info(
    { intervalMs: SCHEDULER_INTERVAL_MS },
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
 * Primarily for clean shutdown in tests; not required in normal operation
 * (Node.js exits regardless of outstanding intervals when the process ends).
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
    const examIds = await getExamsWithEligibleQuestions();
    if (examIds.length === 0) return;

    logger.info(
      { examCount: examIds.length },
      'retryScheduler: tick — found exams with questions due for retry',
    );

    for (const examId of examIds) {
      try {
        await runValidationForExam(examId);
      } catch (err) {
        if (err instanceof DailyQuotaExhaustedError) {
          logger.warn(
            { examId },
            'retryScheduler: daily Gemini quota exhausted — pausing until UTC midnight reset',
          );
          return;   // stop the whole tick; other exams would fail too
        }
        logger.error({ err, examId }, 'retryScheduler: validation failed for exam');
        // continue to next exam — one failure should not block others
      }
    }

    logger.info(
      { examCount: examIds.length },
      'retryScheduler: tick complete',
    );
  } finally {
    running = false;
  }
}

// ─── Eligible exam query ──────────────────────────────────────────────────────

/**
 * Returns distinct exam IDs that have at least one question eligible for retry.
 *
 * Uses the  idx_eca_retry  partial index on (next_retry_at, validation_status)
 * WHERE next_retry_at IS NOT NULL — O(k) where k = eligible rows, not table size.
 *
 * Scales to 100,000 questions / 10,000 exams without changes.
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
