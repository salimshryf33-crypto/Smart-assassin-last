/**
 * examValidation/deadLetterQueue.ts
 *
 * Dead Letter Queue for questions that permanently failed preparation.
 *
 * A question enters the DLQ when it reaches PERMANENT_LOW_EVIDENCE.
 * DLQ records are never deleted — they can be resolved or retried by an admin.
 *
 * Table: public.exam_dlq
 */

import { getSharedPool } from '../dbPool';
import { logger }        from '../logger';
import { v4 as uuidv4 } from 'uuid';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DLQEntry {
  id:                string;
  questionId:        string;
  examId:            string;
  attemptCount:      number;
  lastError:         string | null;
  lastPromptVersion: string | null;
  lastRulesVersion:  string | null;
  createdAt:         Date;
  lastRetry:         Date | null;
  resolvedAt:        Date | null;
  resolvedBy:        string | null;
  resolutionNote:    string | null;
}

// ─── Write ────────────────────────────────────────────────────────────────────

/**
 * Insert a question into the DLQ.
 * Idempotent: ON CONFLICT DO NOTHING ensures duplicate calls are safe.
 */
export async function insertDLQ(params: {
  questionId:        string;
  examId:            string;
  attemptCount:      number;
  lastError?:        string;
  lastPromptVersion?: string;
  lastRulesVersion?: string;
}): Promise<void> {
  const pool = getSharedPool();

  await pool.query(
    `INSERT INTO public.exam_dlq
       (id, question_id, exam_id, attempt_count, last_error, last_prompt_version, last_rules_version, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
     ON CONFLICT (question_id) WHERE resolved_at IS NULL DO UPDATE
       SET attempt_count      = EXCLUDED.attempt_count,
           last_error         = EXCLUDED.last_error,
           last_prompt_version = EXCLUDED.last_prompt_version,
           last_rules_version  = EXCLUDED.last_rules_version`,
    [
      uuidv4(),
      params.questionId,
      params.examId,
      params.attemptCount,
      params.lastError        ?? null,
      params.lastPromptVersion ?? null,
      params.lastRulesVersion  ?? null,
    ],
  );

  logger.warn(
    { questionId: params.questionId, examId: params.examId, attemptCount: params.attemptCount },
    'deadLetterQueue: question entered DLQ',
  );
}

/**
 * Mark a DLQ entry as resolved (admin manual action).
 */
export async function resolveDLQ(
  questionId: string,
  resolvedBy: string,
  note:       string,
): Promise<void> {
  const pool = getSharedPool();
  await pool.query(
    `UPDATE public.exam_dlq
     SET resolved_at = NOW(), resolved_by = $2, resolution_note = $3
     WHERE question_id = $1 AND resolved_at IS NULL`,
    [questionId, resolvedBy, note],
  );
  logger.info({ questionId, resolvedBy }, 'deadLetterQueue: entry resolved');
}

/**
 * Record a retry attempt timestamp on a DLQ entry.
 */
export async function recordDLQRetry(questionId: string): Promise<void> {
  const pool = getSharedPool();
  await pool.query(
    `UPDATE public.exam_dlq SET last_retry = NOW() WHERE question_id = $1 AND resolved_at IS NULL`,
    [questionId],
  );
}

// ─── Read ─────────────────────────────────────────────────────────────────────

export async function listDLQ(opts: {
  examId?:        string;
  unresolvedOnly?: boolean;
  limit?:         number;
  offset?:        number;
}): Promise<{ entries: DLQEntry[]; total: number }> {
  const pool    = getSharedPool();
  const limit   = opts.limit  ?? 50;
  const offset  = opts.offset ?? 0;
  const params: unknown[] = [];
  const where:  string[]  = [];

  if (opts.examId) {
    params.push(opts.examId);
    where.push(`exam_id = $${params.length}`);
  }
  if (opts.unresolvedOnly) {
    where.push('resolved_at IS NULL');
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const [{ rows }, { rows: countRows }] = await Promise.all([
    pool.query<DbRow>(
      `SELECT * FROM public.exam_dlq ${whereClause} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    ),
    pool.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM public.exam_dlq ${whereClause}`,
      params,
    ),
  ]);

  return {
    entries: rows.map(rowToEntry),
    total:   parseInt(countRows[0]?.cnt ?? '0', 10),
  };
}

export async function getDLQEntry(questionId: string): Promise<DLQEntry | null> {
  const pool = getSharedPool();
  const { rows } = await pool.query<DbRow>(
    `SELECT * FROM public.exam_dlq WHERE question_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [questionId],
  );
  return rows[0] ? rowToEntry(rows[0]) : null;
}

export async function getDLQStats(): Promise<{ total: number; unresolved: number; byExam: Array<{ examId: string; count: number }> }> {
  const pool = getSharedPool();
  const [totals, byExam] = await Promise.all([
    pool.query<{ total: string; unresolved: string }>(
      `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE resolved_at IS NULL) AS unresolved FROM public.exam_dlq`,
    ),
    pool.query<{ exam_id: string; cnt: string }>(
      `SELECT exam_id, COUNT(*) AS cnt FROM public.exam_dlq WHERE resolved_at IS NULL GROUP BY exam_id ORDER BY cnt DESC LIMIT 20`,
    ),
  ]);
  return {
    total:      parseInt(totals.rows[0]?.total ?? '0', 10),
    unresolved: parseInt(totals.rows[0]?.unresolved ?? '0', 10),
    byExam:     byExam.rows.map(r => ({ examId: r.exam_id, count: parseInt(r.cnt, 10) })),
  };
}

// ─── DB row → domain ──────────────────────────────────────────────────────────

interface DbRow {
  id:                  string;
  question_id:         string;
  exam_id:             string;
  attempt_count:       number;
  last_error:          string | null;
  last_prompt_version: string | null;
  last_rules_version:  string | null;
  created_at:          Date;
  last_retry:          Date | null;
  resolved_at:         Date | null;
  resolved_by:         string | null;
  resolution_note:     string | null;
}

function rowToEntry(row: DbRow): DLQEntry {
  return {
    id:                row.id,
    questionId:        row.question_id,
    examId:            row.exam_id,
    attemptCount:      row.attempt_count,
    lastError:         row.last_error,
    lastPromptVersion: row.last_prompt_version,
    lastRulesVersion:  row.last_rules_version,
    createdAt:         row.created_at,
    lastRetry:         row.last_retry,
    resolvedAt:        row.resolved_at,
    resolvedBy:        row.resolved_by,
    resolutionNote:    row.resolution_note,
  };
}
