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
  enqueueExam,
  getQueueOverview,
  getJobByExamId,
  getNextExamForSequentialScheduler,
}                                           from './preparationQueue';
import { syncPreparationStatus }            from './examPreparationStatus';

const SCHEDULER_INTERVAL_MS = 5 * 60 * 1_000;   // 5 minutes
const MAX_EXAMS_PER_TICK    = 50;                 // safety cap — prevents infinite loop if
                                                  // many exams each have 0 eligible questions

let schedulerHandle: ReturnType<typeof setInterval> | null = null;
let running                                                  = false;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Start the sequential preparation scheduler.
 * Idempotent — calling more than once has no effect.
 */
export function startRetryScheduler(): void {
  if (schedulerHandle !== null) return;

  logger.info(
    { intervalMs: SCHEDULER_INTERVAL_MS, strategy: 'sequential' },
    'retryScheduler: started (sequential mode)',
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

    // ── 2. Ensure every eligible exam has a preparation job ──────────────────
    await ensureQueuedForEligibleExams();

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
          logger.warn(
            { examId: nextJob.examId },
            'retryScheduler: AI quota exhausted — pausing scheduler until capacity resets',
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
  } finally {
    running = false;
  }
}

// ─── Eligible exam query ──────────────────────────────────────────────────────

/**
 * For every exam with unready questions that has no active preparation job,
 * enqueue it.  Covers all six known question types (deterministic + open).
 */
async function ensureQueuedForEligibleExams(): Promise<void> {
  const pool = getSharedPool();
  const { rows } = await pool.query<{ exam_id: string }>(
    `SELECT DISTINCT unready.exam_id
     FROM (
       -- Deterministic types: mcq / true_false / fill_in_blank without terminal status
       SELECT q.exam_id
       FROM public.exam_questions q
       LEFT JOIN public.exam_canonical_answers ca ON ca.question_id = q.id
       WHERE q.question_type IN ('mcq', 'true_false', 'fill_in_blank')
         AND (ca.validation_status IS NULL
              OR ca.validation_status IN ('PENDING', 'VALIDATED', 'LOW_EVIDENCE'))
       UNION
       -- Open types: orphans (no record) or non-terminal
       SELECT q.exam_id
       FROM public.exam_questions q
       LEFT JOIN public.exam_open_preparations op ON op.question_id = q.id
       WHERE q.question_type IN ('short_answer', 'essay', 'calculation')
         AND (op.question_id IS NULL
              OR op.preparation_status IN ('PENDING', 'VALIDATED', 'LOW_EVIDENCE'))
     ) AS unready
     WHERE NOT EXISTS (
       SELECT 1 FROM public.exam_preparation_jobs epj
       WHERE epj.exam_id = unready.exam_id
         AND epj.status IN ('pending', 'running', 'paused')
     )
     LIMIT 50`,
  );

  for (const { exam_id } of rows) {
    await enqueueExam(exam_id, 1).catch((err: unknown) =>
      logger.error({ err, examId: exam_id }, 'retryScheduler: enqueue failed'),
    );
  }
}
