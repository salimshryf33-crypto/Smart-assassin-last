/**
 * lib/integrity/canonicalVersionStore.ts
 *
 * Phase 4 — Canonical Answer Versioning.
 *
 * exam_canonical_answers (existing, Phase 1-3) remains a single mutable row
 * per question — that behaviour is preserved 100% for backward compatibility.
 *
 * This module adds an APPEND-ONLY history table
 * (public.exam_canonical_answer_versions). Every time the existing
 * canonicalAnswerStore.upsert() is about to change a row, the previous
 * state is snapshotted here first, inside the same transaction, so no
 * historical version is ever lost or overwritten.
 *
 * Invariants:
 *   - INSERT only — this module never UPDATEs or DELETEs a version row.
 *   - version_no is monotonically increasing per question_id.
 *   - Safe to call with no prior row (first version_no = 1).
 */
import type { PoolClient } from 'pg';
import { getSharedPool } from '../dbPool';
import { logger } from '../logger';
import { v4 as uuidv4 } from 'uuid';

export interface CanonicalVersionSnapshot {
  questionId:  string;
  answerPayload: {
    correctOption:    string | null;
    confidence:        number | null;
    reasoningSummary:  string | null;
    validationStatus:  string;
    verified:          boolean;
  };
  evidence: {
    evidenceChunkIds: string[];
    evidencePages:    string[];
  };
}

/**
 * Snapshot the CURRENT row (if any) for question_id into the version
 * history table, then return the next version number to use.
 *
 * Must be called with a client that is inside the same transaction as the
 * subsequent upsert, so the snapshot and the new state are consistent.
 */
export async function snapshotBeforeUpsert(
  client: PoolClient,
  questionId: string,
): Promise<void> {
  // Serialize concurrent upserts for the SAME question within this
  // transaction's lifetime, so MAX(version_no)+1 below can never race
  // between two writers. Held until COMMIT/ROLLBACK; released automatically.
  await client.query(`SELECT pg_advisory_xact_lock(43001, hashtext($1))`, [questionId]);

  const { rows } = await client.query<{
    correct_option: string | null;
    confidence: string | null;
    reasoning_summary: string | null;
    evidence_chunk_ids: unknown;
    evidence_pages: unknown;
    validation_status: string;
    verified: boolean;
  }>(
    `SELECT correct_option, confidence, reasoning_summary,
            evidence_chunk_ids, evidence_pages, validation_status, verified
     FROM public.exam_canonical_answers
     WHERE question_id = $1`,
    [questionId],
  );

  const existing = rows[0];
  if (!existing) return; // nothing to snapshot yet — first write for this question

  const { rows: verRows } = await client.query<{ max_version: number | null }>(
    `SELECT MAX(version_no) AS max_version
     FROM public.exam_canonical_answer_versions
     WHERE question_id = $1`,
    [questionId],
  );
  const nextVersion = (verRows[0]?.max_version ?? 0) + 1;

  // No ON CONFLICT DO NOTHING here: under the advisory lock above, this
  // transaction is the only writer for this question, so a conflict would
  // indicate a real bug rather than a benign race — better to surface it.
  await client.query(
    `INSERT INTO public.exam_canonical_answer_versions
       (id, question_id, version_no, answer_payload, evidence, created_at)
     VALUES ($1, $2, $3, $4, $5, now())`,
    [
      uuidv4(),
      questionId,
      nextVersion,
      JSON.stringify({
        correctOption:    existing.correct_option,
        confidence:        existing.confidence !== null ? parseFloat(existing.confidence) : null,
        reasoningSummary:  existing.reasoning_summary,
        validationStatus:  existing.validation_status,
        verified:          existing.verified,
      }),
      JSON.stringify({
        evidenceChunkIds: existing.evidence_chunk_ids ?? [],
        evidencePages:    existing.evidence_pages ?? [],
      }),
    ],
  );
}

/** List the full historical version chain for a question, oldest first. */
export async function listVersions(questionId: string): Promise<Array<{
  versionNo: number;
  answerPayload: unknown;
  evidence: unknown;
  createdAt: Date;
}>> {
  const pool = getSharedPool();
  const { rows } = await pool.query<{
    version_no: number;
    answer_payload: unknown;
    evidence: unknown;
    created_at: Date;
  }>(
    `SELECT version_no, answer_payload, evidence, created_at
     FROM public.exam_canonical_answer_versions
     WHERE question_id = $1
     ORDER BY version_no ASC`,
    [questionId],
  );
  return rows.map((r) => ({
    versionNo:     r.version_no,
    answerPayload: r.answer_payload,
    evidence:      r.evidence,
    createdAt:     r.created_at,
  }));
}

export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const pool   = getSharedPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch((rollbackErr: unknown) =>
        logger.error({ err: rollbackErr }, 'canonicalVersionStore: rollback failed'),
      );
      throw err;
    }
  } finally {
    client.release();
  }
}
