/**
 * examValidation/canonicalAnswerStore.ts
 *
 * All database operations for the exam_canonical_answers table.
 * Uses raw SQL via the shared pg pool (getSharedPool) so this module
 * remains independent of the Drizzle @workspace/db package.
 *
 * Invariants:
 *   - All SQL uses public.table_name (Neon empty search_path)
 *   - Upsert is idempotent: safe to call multiple times for the same question
 *   - Never touches exam_questions directly EXCEPT the correct_answer column
 *     when a canonical answer reaches READY status
 */

import { getSharedPool }    from '../dbPool';
import { logger }           from '../logger';
import { v4 as uuidv4 }    from 'uuid';
import type {
  CanonicalAnswer,
  ValidationStatus,
  PublishReadinessResult,
} from './types';

// ─── Read ─────────────────────────────────────────────────────────────────────

export async function getByQuestionId(
  questionId: string,
): Promise<CanonicalAnswer | null> {
  const pool = getSharedPool();
  const { rows } = await pool.query<DbRow>(
    `SELECT * FROM public.exam_canonical_answers WHERE question_id = $1 LIMIT 1`,
    [questionId],
  );
  return rows[0] ? rowToCanonical(rows[0]) : null;
}

export async function listByExamId(
  examId: string,
): Promise<CanonicalAnswer[]> {
  const pool = getSharedPool();
  const { rows } = await pool.query<DbRow>(
    `SELECT ca.*
     FROM public.exam_canonical_answers ca
     INNER JOIN public.exam_questions q ON q.id = ca.question_id
     WHERE q.exam_id = $1`,
    [examId],
  );
  return rows.map(rowToCanonical);
}

/**
 * Returns a summary of how many MCQ questions per status for an exam.
 * Used by the publish safety gate and admin diagnostics.
 */
export async function getPublishReadiness(
  examId: string,
): Promise<PublishReadinessResult> {
  const pool = getSharedPool();

  // Fetch all MCQ/true_false questions and their canonical answer status
  const { rows } = await pool.query<{
    question_id:       string;
    validation_status: string | null;
  }>(
    `SELECT q.id AS question_id, ca.validation_status
     FROM public.exam_questions q
     LEFT JOIN public.exam_canonical_answers ca ON ca.question_id = q.id
     WHERE q.exam_id = $1
       AND q.question_type IN ('mcq', 'true_false')`,
    [examId],
  );

  const totalMcq       = rows.length;
  let readyCount        = 0;
  let invalidCount      = 0;
  let lowEvidenceCount  = 0;
  let pendingCount      = 0;
  const blocking: PublishReadinessResult['blockingQuestions'] = [];

  for (const row of rows) {
    const status = row.validation_status as ValidationStatus | null;
    if (status === 'READY') {
      readyCount++;
    } else {
      if (status === 'INVALID')        invalidCount++;
      else if (status === 'LOW_EVIDENCE') lowEvidenceCount++;
      else                             pendingCount++;      // PENDING / VALIDATED / null

      blocking.push({
        id:     row.question_id,
        status: (status ?? 'UNPROCESSED') as ValidationStatus | 'UNPROCESSED',
      });
    }
  }

  return {
    ready:            totalMcq > 0 && readyCount === totalMcq,
    totalMcq,
    readyCount,
    invalidCount,
    lowEvidenceCount,
    pendingCount,
    blockingQuestions: blocking,
  };
}

// ─── Write ────────────────────────────────────────────────────────────────────

/**
 * Upsert a canonical answer record.
 * If a row already exists for question_id it is updated; otherwise inserted.
 */
export async function upsert(
  answer: Omit<CanonicalAnswer, 'id' | 'createdAt' | 'updatedAt'> & { id?: string },
): Promise<CanonicalAnswer> {
  const pool = getSharedPool();
  const id   = answer.id ?? uuidv4();

  const { rows } = await pool.query<DbRow>(
    `INSERT INTO public.exam_canonical_answers
       (id, question_id, correct_option, confidence, reasoning_summary,
        evidence_chunk_ids, evidence_pages, validation_status, retrieval_version, verified)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (question_id) DO UPDATE SET
       correct_option      = EXCLUDED.correct_option,
       confidence          = EXCLUDED.confidence,
       reasoning_summary   = EXCLUDED.reasoning_summary,
       evidence_chunk_ids  = EXCLUDED.evidence_chunk_ids,
       evidence_pages      = EXCLUDED.evidence_pages,
       validation_status   = EXCLUDED.validation_status,
       retrieval_version   = EXCLUDED.retrieval_version,
       verified            = EXCLUDED.verified,
       updated_at          = now()
     RETURNING *`,
    [
      id,
      answer.questionId,
      answer.correctOption      ?? null,
      answer.confidence         ?? null,
      answer.reasoningSummary   ?? null,
      JSON.stringify(answer.evidenceChunkIds),
      JSON.stringify(answer.evidencePages),
      answer.validationStatus,
      answer.retrievalVersion,
      answer.verified,
    ],
  );

  return rowToCanonical(rows[0]!);
}

/**
 * Propagate a READY canonical answer into exam_questions.correct_answer.
 * This is the only write path to exam_questions in the validation module.
 */
export async function populateCorrectAnswer(
  questionId:    string,
  correctOption: string,
): Promise<void> {
  const pool = getSharedPool();
  await pool.query(
    `UPDATE public.exam_questions
     SET correct_answer = $1
     WHERE id = $2
       AND (correct_answer IS NULL OR correct_answer = '')`,
    [correctOption, questionId],
  );
  logger.debug(
    { questionId, correctOption },
    'canonicalAnswerStore: populated correct_answer on exam_questions',
  );
}

/**
 * Count questions for an exam that still need validation.
 * Returns 0 if all MCQ questions are READY.
 */
export async function countUnready(examId: string): Promise<number> {
  const pool = getSharedPool();
  const { rows } = await pool.query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt
     FROM public.exam_questions q
     LEFT JOIN public.exam_canonical_answers ca ON ca.question_id = q.id
     WHERE q.exam_id = $1
       AND q.question_type IN ('mcq', 'true_false')
       AND (ca.validation_status IS NULL OR ca.validation_status != 'READY')`,
    [examId],
  );
  return parseInt(rows[0]?.cnt ?? '0', 10);
}

// ─── DB row → domain type ─────────────────────────────────────────────────────

interface DbRow {
  id:                string;
  question_id:       string;
  correct_option:    string | null;
  confidence:        string | null;
  reasoning_summary: string | null;
  evidence_chunk_ids:unknown;
  evidence_pages:    unknown;
  validation_status: string;
  retrieval_version: number;
  created_at:        Date;
  updated_at:        Date;
  verified:          boolean;
}

function parseJsonArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw as string[];
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) as string[]; } catch { return []; }
  }
  return [];
}

function rowToCanonical(row: DbRow): CanonicalAnswer {
  return {
    id:               row.id,
    questionId:       row.question_id,
    correctOption:    row.correct_option,
    confidence:       row.confidence !== null ? parseFloat(row.confidence) : null,
    reasoningSummary: row.reasoning_summary,
    evidenceChunkIds: parseJsonArray(row.evidence_chunk_ids),
    evidencePages:    parseJsonArray(row.evidence_pages),
    validationStatus: row.validation_status as ValidationStatus,
    retrievalVersion: row.retrieval_version,
    createdAt:        row.created_at,
    updatedAt:        row.updated_at,
    verified:         row.verified,
  };
}
