/**
 * lib/observability/metricsQueries.ts
 *
 * Phase 5 — Dashboard-facing read queries.
 * Every query hits an indexed column (bucket_start, exam_id, question_id) —
 * no full table scans, targets <100ms even at large audit-log volume.
 */
import { getSharedPool } from '../dbPool';

export async function getRecentMetrics(hours = 24) {
  const pool = getSharedPool();
  const { rows } = await pool.query(
    `SELECT bucket_start, questions_per_min, avg_validation_ms, avg_retrieval_ms,
            avg_gemini_ms, success_rate, retry_rate, ready_rate, low_evidence_rate,
            invalid_rate, sample_count
     FROM public.validation_metrics_hourly
     WHERE bucket_start >= now() - ($1 || ' hours')::interval
     ORDER BY bucket_start DESC
     LIMIT 500`,
    [hours],
  );
  return rows;
}

export async function getAuditLog(filters: { examId?: string; questionId?: string; limit?: number }) {
  const pool = getSharedPool();
  const limit = Math.min(filters.limit ?? 100, 500);

  if (filters.questionId) {
    const { rows } = await pool.query(
      `SELECT * FROM public.validation_audit_log
       WHERE question_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [filters.questionId, limit],
    );
    return rows;
  }
  if (filters.examId) {
    const { rows } = await pool.query(
      `SELECT * FROM public.validation_audit_log
       WHERE exam_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [filters.examId, limit],
    );
    return rows;
  }
  const { rows } = await pool.query(
    `SELECT * FROM public.validation_audit_log
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit],
  );
  return rows;
}
