/**
 * examValidation/retryScheduler.ts
 *
 * Adaptive Sequential Scheduler — Phase 4B
 *
 * Strategy: Sequential Exam Completion
 *   ONE exam is prepared at a time until it reaches 100% READY.
 *   Only then does the scheduler move to the next exam.
 *   This maximises completed exams and minimises partial preparation.
 *
 * Ordering (within the same tick):
 *   1. Running jobs first  — never abandon mid-exam
 *   2. Priority ASC        — manual priority takes precedence
 *   3. Ready % DESC        — most-complete exam next (finish fastest)
 *   4. Created-at ASC      — oldest as tiebreaker
 *
 * Capacity behaviour:
 *   - Provider-agnostic: no hardcoded quota values
 *   - If AI capacity is available → chains to the next exam automatically
 *   - If quota is exhausted → pauses cleanly; resumes on next tick
 *   - If an exam's remaining questions are all in retry windows → advances to
 *     the next eligible exam without wasting a tick waiting
 *
 * Resume safety:
 *   - `runValidationForExam` is idempotent: it skips READY/terminal questions
 *   - Job rows persist progress (ready_questions / total_questions)
 *   - Stale-job recovery resets crashed workers so they can be claimed again
 *
 * Original behaviour preserved:
 *   - Stops cleanly on DailyQuotaExhaustedError
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
  reconcilePreparationQueue,
  getQueueOverview,
  getJobByExamId,
  getNextExamForSequentialScheduler,
}                                           from './preparationQueue';
import { syncPreparationStatus }            from './examPreparationStatus';

const SCHEDULER_INTERVAL_MS = 5 * 60 * 1_000;   // 5 minutes
const QUOTA_RESUME_GRACE_MS = 5_000;             // allow the UTC quota reset to settle
const MAX_EXAMS_PER_TICK    = 50;                 // safety cap — prevents infinite loop if
                                                  // many exams each have 0 eligible questions

let schedulerHandle: ReturnType<typeof setInterval> | null = null;
let quotaResumeHandle: ReturnType<typeof setTimeout> | null = null;
let quotaPausedUntil = 0;
let running                                                  = false;
let schedulerStartedAt: Date | null = null;
let lastTickStartedAt: Date | null = null;
let lastTickCompletedAt: Date | null = null;
let lastTickError: string | null = null;
let schedulerInitialized = false;
let startupRestoreInProgress = false;

export interface RetrySchedulerHealth {
  processRunning: boolean;
  schedulerStartedAt: string | null;
  lastTickStartedAt: string | null;
  lastTickCompletedAt: string | null;
  lastTickError: string | null;
  quotaPausedUntil: string | null;
}

export function getRetrySchedulerHealth(): RetrySchedulerHealth {
  return {
    processRunning: schedulerHandle !== null,
    schedulerStartedAt: schedulerStartedAt?.toISOString() ?? null,
    lastTickStartedAt: lastTickStartedAt?.toISOString() ?? null,
    lastTickCompletedAt: lastTickCompletedAt?.toISOString() ?? null,
    lastTickError,
    quotaPausedUntil: quotaPausedUntil > Date.now()
      ? new Date(quotaPausedUntil).toISOString()
      : null,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Start the sequential preparation scheduler.
 * Idempotent — calling more than once has no effect.
 */
export function startRetryScheduler(): void {
  if (schedulerHandle !== null) return;

  schedulerInitialized = false;
  schedulerStartedAt = new Date();
  lastTickError = null;
  logger.info(
    { intervalMs: SCHEDULER_INTERVAL_MS, strategy: 'sequential' },
    'retryScheduler: started (sequential mode)',
  );

  schedulerHandle = setInterval(() => {
    if (!schedulerInitialized) {
      initializeSchedulerAfterRestore().catch((err) =>
        logger.error({ err }, 'retryScheduler: quota restore retry failed'),
      );
      return;
    }
    runRetryTick().catch((err) =>
      logger.error({ err }, 'retryScheduler: tick error'),
    );
  }, SCHEDULER_INTERVAL_MS);

  initializeSchedulerAfterRestore().catch((err) =>
    logger.error({ err }, 'retryScheduler: initial resume check failed'),
  );
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
  if (quotaResumeHandle !== null) {
    clearTimeout(quotaResumeHandle);
    quotaResumeHandle = null;
  }
  quotaPausedUntil = 0;
  schedulerInitialized = false;
}

// ─── Internal tick ────────────────────────────────────────────────────────────

async function runRetryTick(): Promise<void> {
  if (running) {
    logger.debug('retryScheduler: previous tick still running — skipping');
    return;
  }
  if (quotaPausedUntil > Date.now()) {
    logger.debug(
      { resumeAt: new Date(quotaPausedUntil).toISOString() },
      'retryScheduler: waiting for Gemini daily quota reset',
    );
    return;
  }
  if (quotaPausedUntil !== 0) {
    quotaPausedUntil = 0;
    quotaResumeHandle = null;
  }
  lastTickStartedAt = new Date();
  lastTickError = null;
  running = true;

  try {
    // ── 1. Recover stale crashed workers ─────────────────────────────────────
    const recovered = await recoverStaleJobs();
    if (recovered > 0) {
      logger.info({ recovered }, 'retryScheduler: recovered stale preparation jobs');
    }

    // ── 2. Reconcile only exams with due work from live per-question state ────
    await reconcilePreparationQueue();

    const overview = await getQueueOverview();
    if (overview.pending === 0 && overview.running === 0 && overview.paused === 0) {
      logger.debug('retryScheduler: tick — queue empty, nothing to do');
      return;
    }

    logger.info(
      { queue: overview, strategy: 'sequential' },
      'retryScheduler: tick — sequential processing',
    );

    // ── 3. Sequential chaining loop ───────────────────────────────────────────
    // Process ONE exam at a time.  When it completes, automatically chain to
    // the next exam so available AI capacity is never left unused.
    let examsProcessed = 0;

    while (examsProcessed < MAX_EXAMS_PER_TICK) {
      // Pick the single best next exam (running > priority > readyPct > age)
      const nextJob = await getNextExamForSequentialScheduler();
      if (!nextJob) {
        logger.debug('retryScheduler: sequential — queue drained');
        break;
      }

      logger.info(
        {
          examId:         nextJob.examId,
          status:         nextJob.status,
          priority:       nextJob.priority,
          readyQuestions: nextJob.readyQuestions,
          totalQuestions: nextJob.totalQuestions,
        },
        'retryScheduler: sequential — processing exam',
      );

      try {
        await runValidationForExam(nextJob.examId);
      } catch (err) {
        if (err instanceof DailyQuotaExhaustedError) {
          scheduleQuotaResume();
          logger.warn(
            {
              examId: nextJob.examId,
              resumeAt: new Date(quotaPausedUntil).toISOString(),
            },
            'retryScheduler: AI quota exhausted — scheduled automatic resume after UTC reset',
          );
          return;   // stop the entire tick; other exams would fail too
        }
        logger.error(
          { err, examId: nextJob.examId },
          'retryScheduler: validation failed for exam',
        );
        // Count as processed so we don't loop forever on a broken exam
        examsProcessed++;
        continue;
      }

      // Sync exam-level preparation_status
      await syncPreparationStatus(nextJob.examId).catch((err: unknown) =>
        logger.error({ err, examId: nextJob.examId }, 'retryScheduler: syncPreparationStatus failed'),
      );

      examsProcessed++;

      // Check whether the exam actually completed or is still in a wait state
      const updatedJob = await getJobByExamId(nextJob.examId);
      if (!updatedJob || updatedJob.status !== 'completed') {
        // Exam paused (quota mid-exam) or made no progress (retry windows not yet due)
        // Either way, stop this tick — the next tick will resume.
        logger.debug(
          { examId: nextJob.examId, jobStatus: updatedJob?.status },
          'retryScheduler: exam did not complete — stopping tick',
        );
        break;
      }

      // Exam completed — chain to next exam and consume remaining capacity
      logger.info(
        { examId: nextJob.examId, examsProcessed },
        'retryScheduler: exam completed — chaining to next exam',
      );
    }

    logger.info(
      { examsProcessed },
      'retryScheduler: sequential tick complete',
    );
  } catch (err) {
    lastTickError = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    running = false;
    lastTickCompletedAt = new Date();
  }
}

function scheduleQuotaResume(): void {
  const now = new Date();
  const nextReset = new Date(now);
  nextReset.setUTCHours(24, 0, 0, 0);
  const resumeAt = nextReset.getTime() + QUOTA_RESUME_GRACE_MS;

  quotaPausedUntil = resumeAt;
  if (quotaResumeHandle !== null) clearTimeout(quotaResumeHandle);

  quotaResumeHandle = setTimeout(() => {
    quotaResumeHandle = null;
    quotaPausedUntil = 0;
    logger.info(
      { resumeAt: new Date(resumeAt).toISOString() },
      'retryScheduler: daily quota reset window reached — resuming preparation',
    );
    runRetryTick().catch((err) =>
      logger.error({ err }, 'retryScheduler: automatic post-quota resume failed'),
    );
  }, Math.max(1_000, resumeAt - Date.now()));
}

async function restoreQuotaPauseStateAndKick(): Promise<void> {
  const pool = getSharedPool();
  const { rows } = await pool.query<{ last_quota_pause: Date | null }>(`
    SELECT MAX(updated_at) AS last_quota_pause
    FROM public.exam_preparation_jobs
    WHERE status = 'paused'
      AND last_error ILIKE '%quota%'
  `);

  const lastQuotaPause = rows[0]?.last_quota_pause;
  const startOfUtcDay = new Date();
  startOfUtcDay.setUTCHours(0, 0, 0, 0);

  if (lastQuotaPause && new Date(lastQuotaPause).getTime() >= startOfUtcDay.getTime()) {
    scheduleQuotaResume();
    logger.info(
      {
        lastQuotaPause: new Date(lastQuotaPause).toISOString(),
        resumeAt: new Date(quotaPausedUntil).toISOString(),
      },
      'retryScheduler: restored current-day quota pause',
    );
    return;
  }

  // A pause from a previous UTC day is eligible immediately after startup.
  await runRetryTick();
}

async function initializeSchedulerAfterRestore(): Promise<void> {
  if (schedulerInitialized || startupRestoreInProgress) return;
  startupRestoreInProgress = true;
  try {
    await restoreQuotaPauseStateAndKick();
    schedulerInitialized = true;
  } finally {
    startupRestoreInProgress = false;
  }
}
