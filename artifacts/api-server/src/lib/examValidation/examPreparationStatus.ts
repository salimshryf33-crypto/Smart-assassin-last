/**
 * examValidation/examPreparationStatus.ts
 *
 * Computes the exam-level preparation_status from per-question states
 * in exam_canonical_answers and persists it to exam_records.
 *
 * Exam preparation_status values:
 *   pending         — no preparation started yet (no canonical answer rows)
 *   preparing       — preparation is actively running or queued
 *   ready           — 100% of MCQ/TF questions are READY
 *   partially_ready — some READY, others PERMANENT_LOW_EVIDENCE or INVALID
 *   blocked         — critical integrity issue detected
 *   failed          — pipeline permanently failed (no further retries possible)
 */

import { getSharedPool } from '../dbPool';
import { logger }        from '../logger';
import {
  getLivePreparationProgress,
  type LivePreparationProgress,
} from './livePreparationProgress';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ExamPreparationStatus =
  | 'pending'
  | 'preparing'
  | 'ready'
  | 'partially_ready'
  | 'blocked'
  | 'failed';

export interface ExamPreparationSummary {
  examId:            string;
  preparationStatus: ExamPreparationStatus;
  totalMcq:          number;
  readyCount:        number;
  pendingCount:      number;
  preparingCount:    number;
  invalidCount:      number;
  permanentLowCount: number;
  readinessPct:      number; // 0–100
}

// ─── Compute & sync ───────────────────────────────────────────────────────────

/**
 * Compute the exam-level preparation status from question states and write it
 * back to exam_records.preparation_status.
 *
 * Safe to call at any time — idempotent.
 */
export async function syncPreparationStatus(examId: string): Promise<ExamPreparationStatus> {
  const progress = await getLivePreparationProgress(examId);
  const status = derivePreparationStatus(progress);

  await writeStatus(examId, status);

  logger.debug(
    {
      examId,
      status,
      totalPreparable: progress.totalQuestions,
      readyCount: progress.readyQuestions,
      invalidCount: progress.statusCounts.INVALID ?? 0,
      permLowCount: progress.statusCounts.PERMANENT_LOW_EVIDENCE ?? 0,
      pendingCount: progress.statusCounts.PENDING ?? 0,
      preparingCount: getPreparingCount(progress),
    },
    'examPreparationStatus: synced',
  );

  return status;
}

/**
 * Batch-compute preparation status for all exams with 'done' extraction.
 * Used at startup to backfill.
 */
export async function syncAllPreparationStatuses(): Promise<void> {
  const pool = getSharedPool();
  const { rows } = await pool.query<{ exam_id: string }>(
    `SELECT exam_id FROM public.exam_records WHERE extraction_status = 'done' AND question_count > 0`,
  );
  let updated = 0;
  for (const { exam_id } of rows) {
    await syncPreparationStatus(exam_id);
    updated++;
  }
  logger.info({ updated }, 'examPreparationStatus: batch sync complete');
}

/**
 * Get the preparation summary for one exam (read-only, no write).
 */
export async function getPreparationSummary(examId: string): Promise<ExamPreparationSummary> {
  const pool = getSharedPool();
  const [progress, recordResult] = await Promise.all([
    getLivePreparationProgress(examId),
    pool.query<{ preparation_status: string | null }>(
      `SELECT preparation_status FROM public.exam_records WHERE exam_id = $1 LIMIT 1`,
      [examId],
    ),
  ]);
  const counts = progress.statusCounts;
  const recordExists = (recordResult.rowCount ?? 0) > 0;

  return {
    examId,
    preparationStatus: recordExists ? derivePreparationStatus(progress) : 'pending',
    totalMcq:          progress.totalQuestions, // legacy name: all preparable questions
    readyCount:        progress.readyQuestions,
    pendingCount:      counts.PENDING ?? 0,
    preparingCount:    getPreparingCount(progress),
    invalidCount:      counts.INVALID ?? 0,
    permanentLowCount: counts.PERMANENT_LOW_EVIDENCE ?? 0,
    readinessPct:      progress.progressPct,
  };
}

function getPreparingCount(progress: LivePreparationProgress): number {
  const counts = progress.statusCounts;
  return (counts.PROCESSING ?? 0) +
    (counts.GENERATING ?? 0) +
    (counts.VALIDATED ?? 0) +
    (counts.LOW_EVIDENCE ?? 0);
}

function derivePreparationStatus(progress: LivePreparationProgress): ExamPreparationStatus {
  const counts = progress.statusCounts;
  if (progress.totalQuestions === 0 || progress.readyQuestions === progress.totalQuestions) {
    return 'ready';
  }
  const pendingCount = counts.PENDING ?? 0;
  const preparingCount = getPreparingCount(progress);
  if (progress.readyQuestions > 0 && pendingCount === 0 && preparingCount === 0) {
    return 'partially_ready';
  }
  if (preparingCount > 0 || pendingCount > 0) return 'preparing';
  if ((counts.INVALID ?? 0) + (counts.PERMANENT_LOW_EVIDENCE ?? 0) === progress.totalQuestions) {
    return 'failed';
  }
  return 'preparing';
}

// ─── Internal write ───────────────────────────────────────────────────────────

async function writeStatus(examId: string, status: ExamPreparationStatus): Promise<void> {
  const pool = getSharedPool();
  await pool.query(
    `UPDATE public.exam_records
     SET preparation_status = $2, updated_at = NOW()
     WHERE exam_id = $1`,
    [examId, status],
  );
}
