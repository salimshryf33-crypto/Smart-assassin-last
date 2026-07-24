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
  const pool = getSharedPool();

  // ── Canonical (MCQ / true_false / fill_in_blank) ──────────────────────────
  const { rows: canonRows } = await pool.query<{
    total:          string;
    ready_count:    string;
    invalid_count:  string;
    perm_low_count: string;
    pending_count:  string;
    preparing_count:string;
  }>(
    `SELECT
       COUNT(*)                                                                                    AS total,
       COUNT(*) FILTER (WHERE ca.validation_status = 'READY')                                     AS ready_count,
       COUNT(*) FILTER (WHERE ca.validation_status = 'INVALID')                                   AS invalid_count,
       COUNT(*) FILTER (WHERE ca.validation_status = 'PERMANENT_LOW_EVIDENCE')                    AS perm_low_count,
       COUNT(*) FILTER (WHERE ca.validation_status IS NULL OR ca.validation_status = 'PENDING')   AS pending_count,
       COUNT(*) FILTER (WHERE ca.validation_status IN ('GENERATING','VALIDATED','LOW_EVIDENCE'))   AS preparing_count
     FROM public.exam_questions eq
     LEFT JOIN public.exam_canonical_answers ca ON ca.question_id = eq.id
     WHERE eq.exam_id = $1
       AND eq.question_type IN ('mcq','true_false','fill_in_blank')`,
    [examId],
  );

  // ── Open (short_answer / calculation / essay) ─────────────────────────────
  const { rows: openRows } = await pool.query<{
    total:          string;
    ready_count:    string;
    invalid_count:  string;
    perm_low_count: string;
    pending_count:  string;
    preparing_count:string;
  }>(
    `SELECT
       COUNT(*)                                                                                    AS total,
       COUNT(*) FILTER (WHERE op.preparation_status = 'READY')                                    AS ready_count,
       COUNT(*) FILTER (WHERE op.preparation_status = 'INVALID')                                  AS invalid_count,
       COUNT(*) FILTER (WHERE op.preparation_status = 'PERMANENT_LOW_EVIDENCE')                   AS perm_low_count,
       COUNT(*) FILTER (WHERE op.preparation_status IS NULL OR op.preparation_status = 'PENDING') AS pending_count,
       COUNT(*) FILTER (WHERE op.preparation_status IN ('VALIDATED','LOW_EVIDENCE'))              AS preparing_count
     FROM public.exam_questions eq
     LEFT JOIN public.exam_open_preparations op ON op.question_id = eq.id
     WHERE eq.exam_id = $1
       AND eq.question_type IN ('short_answer','calculation','essay')`,
    [examId],
  );

  const canon = canonRows[0];
  const open  = openRows[0];

  // Aggregate across both tables
  const totalPreparable  = parseInt(canon?.total ?? '0', 10) + parseInt(open?.total ?? '0', 10);
  const readyCount       = parseInt(canon?.ready_count    ?? '0', 10) + parseInt(open?.ready_count    ?? '0', 10);
  const invalidCount     = parseInt(canon?.invalid_count  ?? '0', 10) + parseInt(open?.invalid_count  ?? '0', 10);
  const permLowCount     = parseInt(canon?.perm_low_count ?? '0', 10) + parseInt(open?.perm_low_count ?? '0', 10);
  const pendingCount     = parseInt(canon?.pending_count  ?? '0', 10) + parseInt(open?.pending_count  ?? '0', 10);
  const preparingCount   = parseInt(canon?.preparing_count?? '0', 10) + parseInt(open?.preparing_count?? '0', 10);

  let status: ExamPreparationStatus;

  if (totalPreparable === 0) {
    // Exam has no questions that need preparation
    status = 'ready';
  } else if (readyCount === totalPreparable) {
    status = 'ready';
  } else if (readyCount > 0 && pendingCount === 0 && preparingCount === 0) {
    // Some READY, rest are terminal (INVALID or PERMANENT_LOW_EVIDENCE)
    status = 'partially_ready';
  } else if (preparingCount > 0) {
    status = 'preparing';
  } else if (pendingCount > 0) {
    status = 'preparing';
  } else if (invalidCount + permLowCount === totalPreparable) {
    // Every question failed permanently
    status = 'failed';
  } else {
    status = 'preparing';
  }

  await writeStatus(examId, status);

  logger.debug(
    {
      examId,
      status,
      totalPreparable,
      readyCount,
      invalidCount,
      permLowCount,
      pendingCount,
      preparingCount,
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

  // Canonical (MCQ/TF/fill_in_blank) stats
  const { rows: canonRows } = await pool.query<{
    total:          string;
    ready_count:    string;
    invalid_count:  string;
    perm_low_count: string;
    pending_count:  string;
    preparing_count:string;
    prep_status:    string | null;
  }>(
    `SELECT
       COUNT(eq.id)                                                                                AS total,
       COUNT(*) FILTER (WHERE ca.validation_status = 'READY')                                     AS ready_count,
       COUNT(*) FILTER (WHERE ca.validation_status = 'INVALID')                                   AS invalid_count,
       COUNT(*) FILTER (WHERE ca.validation_status = 'PERMANENT_LOW_EVIDENCE')                    AS perm_low_count,
       COUNT(*) FILTER (WHERE ca.validation_status IS NULL OR ca.validation_status = 'PENDING')   AS pending_count,
       COUNT(*) FILTER (WHERE ca.validation_status IN ('GENERATING','VALIDATED','LOW_EVIDENCE'))   AS preparing_count,
       er.preparation_status AS prep_status
     FROM public.exam_records er
     LEFT JOIN public.exam_questions eq ON eq.exam_id = er.exam_id
       AND eq.question_type IN ('mcq','true_false','fill_in_blank')
     LEFT JOIN public.exam_canonical_answers ca ON ca.question_id = eq.id
     WHERE er.exam_id = $1
     GROUP BY er.exam_id, er.preparation_status`,
    [examId],
  );

  // Open (short_answer/calculation/essay) stats
  const { rows: openRows } = await pool.query<{
    total:          string;
    ready_count:    string;
    invalid_count:  string;
    perm_low_count: string;
    pending_count:  string;
    preparing_count:string;
  }>(
    `SELECT
       COUNT(eq.id)                                                                                AS total,
       COUNT(*) FILTER (WHERE op.preparation_status = 'READY')                                    AS ready_count,
       COUNT(*) FILTER (WHERE op.preparation_status = 'INVALID')                                  AS invalid_count,
       COUNT(*) FILTER (WHERE op.preparation_status = 'PERMANENT_LOW_EVIDENCE')                   AS perm_low_count,
       COUNT(*) FILTER (WHERE op.preparation_status IS NULL OR op.preparation_status = 'PENDING') AS pending_count,
       COUNT(*) FILTER (WHERE op.preparation_status IN ('VALIDATED','LOW_EVIDENCE'))              AS preparing_count
     FROM public.exam_questions eq
     LEFT JOIN public.exam_open_preparations op ON op.question_id = eq.id
     WHERE eq.exam_id = $1
       AND eq.question_type IN ('short_answer','calculation','essay')`,
    [examId],
  );

  if (!canonRows[0]) {
    return {
      examId,
      preparationStatus: 'pending',
      totalMcq:          0,
      readyCount:        0,
      pendingCount:      0,
      preparingCount:    0,
      invalidCount:      0,
      permanentLowCount: 0,
      readinessPct:      0,
    };
  }

  const canon = canonRows[0];
  const open  = openRows[0];

  const totalMcq        = parseInt(canon.total         ?? '0', 10);
  const totalOpen       = parseInt(open?.total         ?? '0', 10);
  const totalPreparable = totalMcq + totalOpen;

  const readyCount    = parseInt(canon.ready_count    ?? '0', 10) + parseInt(open?.ready_count    ?? '0', 10);
  const pendingCount  = parseInt(canon.pending_count  ?? '0', 10) + parseInt(open?.pending_count  ?? '0', 10);
  const preparingCount= parseInt(canon.preparing_count?? '0', 10) + parseInt(open?.preparing_count?? '0', 10);
  const invalidCount  = parseInt(canon.invalid_count  ?? '0', 10) + parseInt(open?.invalid_count  ?? '0', 10);
  const permLowCount  = parseInt(canon.perm_low_count ?? '0', 10) + parseInt(open?.perm_low_count ?? '0', 10);

  return {
    examId,
    preparationStatus: (canon.prep_status ?? 'pending') as ExamPreparationStatus,
    totalMcq:          totalPreparable, // field kept for API compat; now means "all preparable"
    readyCount,
    pendingCount,
    preparingCount,
    invalidCount,
    permanentLowCount: permLowCount,
    readinessPct:      totalPreparable > 0 ? Math.round((readyCount / totalPreparable) * 100) : 100,
  };
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
