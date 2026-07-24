/**
 * examValidation/openPreparationStore.ts
 *
 * CRUD operations for the exam_open_preparations table.
 *
 * Stores preparation packages for open-ended question types:
 * short_answer, calculation, essay.
 *
 * Follows the same conventions as canonicalAnswerStore.ts:
 *   - All SQL uses public.table_name (Neon empty search_path)
 *   - Upsert is idempotent
 *   - Never modifies exam_questions directly
 */

import { getSharedPool } from '../dbPool';
import { logger }        from '../logger';
import { v4 as uuidv4 } from 'uuid';
import type { ValidationStatus } from './types';
import type { OpenPreparationPackage } from './openPreparationDeriver';

// ─── Domain type ──────────────────────────────────────────────────────────────

export interface OpenPreparation {
  id:                string;
  questionId:        string;
  examId:            string;
  questionType:      string;
  preparationStatus: ValidationStatus;
  package:           OpenPreparationPackage | null;
  confidence:        number | null;
  evidenceChunkIds:  string[];
  evidencePages:     string[];
  reasoningSummary:  string | null;
  attemptCount:      number;
  lastAttemptAt:     Date | null;
  nextRetryAt:       Date | null;
  retrievalVersion:  number;
  createdAt:         Date;
  updatedAt:         Date;
}

export type UpsertOpenPreparation = Omit<OpenPreparation, 'id' | 'createdAt' | 'updatedAt'> & { id?: string };

// ─── Read ─────────────────────────────────────────────────────────────────────

export async function getByQuestionId(questionId: string): Promise<OpenPreparation | null> {
  const pool = getSharedPool();
  const { rows } = await pool.query<DbRow>(
    `SELECT * FROM public.exam_open_preparations WHERE question_id = $1 LIMIT 1`,
    [questionId],
  );
  return rows[0] ? rowToDomain(rows[0]) : null;
}

export async function listByExamId(examId: string): Promise<OpenPreparation[]> {
  const pool = getSharedPool();
  const { rows } = await pool.query<DbRow>(
    `SELECT op.*
     FROM public.exam_open_preparations op
     WHERE op.exam_id = $1`,
    [examId],
  );
  return rows.map(rowToDomain);
}

/**
 * Count open-ended questions for an exam still eligible for (re-)preparation.
 * Mirrors countUnready() from canonicalAnswerStore.ts.
 */
export async function countUnreadyOpen(examId: string): Promise<number> {
  const pool = getSharedPool();
  const { rows } = await pool.query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt
     FROM public.exam_questions q
     LEFT JOIN public.exam_open_preparations op ON op.question_id = q.id
     WHERE q.exam_id = $1
       AND q.question_type IN ('short_answer', 'essay', 'calculation')
       AND (
         op.preparation_status IS NULL
         OR (
           op.preparation_status IN ('PENDING', 'VALIDATED', 'LOW_EVIDENCE')
           AND (op.next_retry_at IS NULL OR op.next_retry_at <= now())
         )
       )`,
    [examId],
  );
  return parseInt(rows[0]?.cnt ?? '0', 10);
}

// ─── Write ────────────────────────────────────────────────────────────────────

export async function upsert(record: UpsertOpenPreparation): Promise<OpenPreparation> {
  const pool = getSharedPool();
  const id   = record.id ?? uuidv4();

  const { rows } = await pool.query<DbRow>(
    `INSERT INTO public.exam_open_preparations
       (id, question_id, exam_id, question_type, preparation_status,
        package, confidence, evidence_chunk_ids, evidence_pages, reasoning_summary,
        attempt_count, last_attempt_at, next_retry_at, retrieval_version,
        created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now(),now())
     ON CONFLICT (question_id) DO UPDATE SET
       preparation_status  = EXCLUDED.preparation_status,
       package             = EXCLUDED.package,
       confidence          = EXCLUDED.confidence,
       evidence_chunk_ids  = EXCLUDED.evidence_chunk_ids,
       evidence_pages      = EXCLUDED.evidence_pages,
       reasoning_summary   = EXCLUDED.reasoning_summary,
       attempt_count       = EXCLUDED.attempt_count,
       last_attempt_at     = EXCLUDED.last_attempt_at,
       next_retry_at       = EXCLUDED.next_retry_at,
       retrieval_version   = EXCLUDED.retrieval_version,
       updated_at          = now()
     RETURNING *`,
    [
      id,
      record.questionId,
      record.examId,
      record.questionType,
      record.preparationStatus,
      record.package !== null ? JSON.stringify(record.package) : null,
      record.confidence    ?? null,
      JSON.stringify(record.evidenceChunkIds),
      JSON.stringify(record.evidencePages),
      record.reasoningSummary ?? null,
      record.attemptCount,
      record.lastAttemptAt ?? null,
      record.nextRetryAt   ?? null,
      record.retrievalVersion,
    ],
  );

  logger.debug(
    { questionId: record.questionId, status: record.preparationStatus },
    'openPreparationStore: upserted',
  );

  return rowToDomain(rows[0]!);
}

// ─── DB row → domain ──────────────────────────────────────────────────────────

interface DbRow {
  id:                 string;
  question_id:        string;
  exam_id:            string;
  question_type:      string;
  preparation_status: string;
  package:            unknown;
  confidence:         string | null;
  evidence_chunk_ids: unknown;
  evidence_pages:     unknown;
  reasoning_summary:  string | null;
  attempt_count:      number;
  last_attempt_at:    Date | null;
  next_retry_at:      Date | null;
  retrieval_version:  number;
  created_at:         Date;
  updated_at:         Date;
}

function parseJsonArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw as string[];
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) as string[]; } catch { return []; }
  }
  return [];
}

function rowToDomain(row: DbRow): OpenPreparation {
  let pkg: OpenPreparationPackage | null = null;
  if (row.package) {
    try {
      pkg = (typeof row.package === 'string'
        ? JSON.parse(row.package)
        : row.package) as OpenPreparationPackage;
    } catch {
      pkg = null;
    }
  }

  return {
    id:                row.id,
    questionId:        row.question_id,
    examId:            row.exam_id,
    questionType:      row.question_type,
    preparationStatus: row.preparation_status as ValidationStatus,
    package:           pkg,
    confidence:        row.confidence !== null ? parseFloat(row.confidence) : null,
    evidenceChunkIds:  parseJsonArray(row.evidence_chunk_ids),
    evidencePages:     parseJsonArray(row.evidence_pages),
    reasoningSummary:  row.reasoning_summary,
    attemptCount:      row.attempt_count ?? 0,
    lastAttemptAt:     row.last_attempt_at  ?? null,
    nextRetryAt:       row.next_retry_at    ?? null,
    retrievalVersion:  row.retrieval_version ?? 1,
    createdAt:         row.created_at,
    updatedAt:         row.updated_at,
  };
}
