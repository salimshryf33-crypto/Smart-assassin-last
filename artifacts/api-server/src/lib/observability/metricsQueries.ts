/**
 * lib/observability/metricsQueries.ts
 *
 * Phase 5 — Dashboard-facing read queries.
 * Phase 3 extension — grading audit queries (grading_outcome events).
 *
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

// ─── Grading audit (Phase 3) ──────────────────────────────────────────────────

/**
 * Return grading_outcome audit rows from public.validation_audit_log.
 *
 * All 12 required grading fields are in the JSONB payload column.
 * Supports filtering by examId, questionId, attemptId, and finalClassification.
 * Ordered newest-first. Capped at 500 rows.
 */
export async function getGradingAuditLog(filters: {
  examId?:              string;
  questionId?:          string;
  attemptId?:           string;           // matched inside payload JSONB
  finalClassification?: string;           // matched inside payload JSONB
  limit?:               number;
}) {
  const pool  = getSharedPool();
  const limit = Math.min(filters.limit ?? 100, 500);
  const where: string[] = [`event = 'grading_outcome'`];
  const params: unknown[] = [];

  if (filters.examId) {
    params.push(filters.examId);
    where.push(`exam_id = $${params.length}`);
  }
  if (filters.questionId) {
    params.push(filters.questionId);
    where.push(`question_id = $${params.length}`);
  }
  if (filters.attemptId) {
    params.push(filters.attemptId);
    where.push(`payload->>'attemptId' = $${params.length}`);
  }
  if (filters.finalClassification) {
    params.push(filters.finalClassification);
    where.push(`payload->>'finalClassification' = $${params.length}`);
  }

  params.push(limit);
  const { rows } = await pool.query(
    `SELECT id, exam_id, question_id, severity, duration_ms, payload, created_at
     FROM public.validation_audit_log
     WHERE ${where.join(' AND ')}
     ORDER BY created_at DESC
     LIMIT $${params.length}`,
    params,
  );
  return rows;
}

/**
 * Aggregate grading_outcome statistics for a single exam.
 * Returns counts by finalClassification and averages by gradingStrategy.
 * Used by GET /api/admin/grading-audit?examId=&summary=1.
 */
export async function getGradingAuditSummary(examId: string) {
  const pool = getSharedPool();

  const [classificationRows, strategyRows, pendingRows] = await Promise.all([
    // Count by finalClassification
    pool.query<{ classification: string; count: string }>(
      `SELECT payload->>'finalClassification' AS classification, COUNT(*) AS count
       FROM public.validation_audit_log
       WHERE event = 'grading_outcome' AND exam_id = $1
       GROUP BY classification`,
      [examId],
    ),
    // Average duration_ms + count by gradingStrategy
    pool.query<{ strategy: string; count: string; avg_ms: string | null }>(
      `SELECT payload->>'gradingStrategy' AS strategy,
              COUNT(*) AS count,
              AVG(duration_ms)::numeric(10,2) AS avg_ms
       FROM public.validation_audit_log
       WHERE event = 'grading_outcome' AND exam_id = $1
       GROUP BY strategy`,
      [examId],
    ),
    // Questions still pending preparation (most recent event per question)
    pool.query<{ question_id: string; preparation_status: string; created_at: Date }>(
      `SELECT DISTINCT ON (question_id) question_id,
              payload->>'preparationStatus' AS preparation_status,
              created_at
       FROM public.validation_audit_log
       WHERE event = 'grading_outcome'
         AND exam_id = $1
         AND payload->>'finalClassification' = 'pending_preparation'
       ORDER BY question_id, created_at DESC`,
      [examId],
    ),
  ]);

  const byClassification = Object.fromEntries(
    classificationRows.rows.map(r => [r.classification, parseInt(r.count, 10)]),
  );
  const byStrategy = Object.fromEntries(
    strategyRows.rows.map(r => [
      r.strategy,
      { count: parseInt(r.count, 10), avgDurationMs: r.avg_ms ? parseFloat(r.avg_ms) : null },
    ]),
  );

  const total = Object.values(byClassification).reduce((s, n) => s + n, 0);

  return {
    examId,
    total,
    byClassification,
    byStrategy,
    pendingPreparation: pendingRows.rows.map(r => ({
      questionId:        r.question_id,
      preparationStatus: r.preparation_status,
      lastAttemptAt:     r.created_at,
    })),
  };
}
