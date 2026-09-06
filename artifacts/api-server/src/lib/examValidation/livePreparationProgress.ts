/**
 * Live preparation progress.
 *
 * This is the only source used for user-facing preparation progress. Job
 * counters are snapshots for operations and may be null or stale.
 */

import { getSharedPool } from '../dbPool';
import { PREPARATION_REQUIRED_TYPES } from '../questionTypeRegistry';

/**
 * READY is the only persisted state that the existing preparation pipeline
 * considers usable. VALIDATED and LOW_EVIDENCE are still in progress, while
 * INVALID and PERMANENT_LOW_EVIDENCE are terminal but not usable.
 */
export const PREPARATION_USABLE_STATUSES = ['READY'] as const;

export type PreparationUsableStatus = (typeof PREPARATION_USABLE_STATUSES)[number];

export interface LivePreparationProgress {
  examId: string;
  totalQuestions: number;
  readyQuestions: number;
  progressPct: number;
  remainingQuestions: number;
  statusCounts: Record<string, number>;
}

interface PreparationStatusRow {
  question_type: string;
  preparation_status: string;
}

const STATUS_KEYS = [
  'READY',
  'VALIDATED',
  'PENDING',
  'PROCESSING',
  'LOW_EVIDENCE',
  'PERMANENT_LOW_EVIDENCE',
  'INVALID',
] as const;

function emptyStatusCounts(): Record<string, number> {
  return Object.fromEntries(STATUS_KEYS.map((status) => [status, 0]));
}

/**
 * Read the current persisted preparation state for every preparable question
 * in one exam and derive all progress/remaining values from that state.
 */
export async function getLivePreparationProgress(examId: string): Promise<LivePreparationProgress> {
  const pool = getSharedPool();
  const preparableTypes = [...PREPARATION_REQUIRED_TYPES];
  const { rows } = await pool.query<PreparationStatusRow>(
    `SELECT
       q.question_type,
       CASE
         WHEN q.question_type IN ('mcq','true_false','fill_in_blank')
           THEN COALESCE(ca.validation_status, 'PENDING')
         ELSE COALESCE(UPPER(op.preparation_status), 'PENDING')
       END AS preparation_status
     FROM public.exam_questions q
     LEFT JOIN public.exam_canonical_answers ca
       ON ca.question_id = q.id
     LEFT JOIN public.exam_open_preparations op
       ON op.question_id = q.id
     WHERE q.exam_id = $1
       AND q.question_type = ANY($2::text[])`,
    [examId, preparableTypes],
  );

  const statusCounts = emptyStatusCounts();
  for (const row of rows) {
    const status = row.preparation_status || 'PENDING';
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
  }

  const totalQuestions = rows.length;
  const readyQuestions = PREPARATION_USABLE_STATUSES.reduce(
    (count, status) => count + (statusCounts[status] ?? 0),
    0,
  );
  const progressPct = totalQuestions > 0
    ? Math.round((readyQuestions / totalQuestions) * 100)
    : 0;

  return {
    examId,
    totalQuestions,
    readyQuestions,
    progressPct,
    remainingQuestions: Math.max(0, totalQuestions - readyQuestions),
    statusCounts,
  };
}

export async function getLivePreparationProgressForExams(
  examIds: string[],
): Promise<Map<string, LivePreparationProgress>> {
  const progress = await Promise.all(examIds.map((examId) => getLivePreparationProgress(examId)));
  return new Map(progress.map((entry) => [entry.examId, entry]));
}