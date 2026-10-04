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
  retryableQuestions: number;
  waitingRetryQuestions: number;
  terminalFailedQuestions: number;
  nextEligibleAt: string | null;
  statusCounts: Record<string, number>;
}

interface PreparationStatusRow {
  exam_id: string;
  question_type: string;
  preparation_status: string;
  next_retry_at: Date | string | null;
}

const STATUS_KEYS = [
  'READY',
  'VALIDATED',
  'PENDING',
  'PROCESSING',
  'GENERATING',
  'LOW_EVIDENCE',
  'PERMANENT_LOW_EVIDENCE',
  'INVALID',
] as const;

const RETRYABLE_STATUSES = new Set([
  'PENDING',
  'VALIDATED',
  'PROCESSING',
  'GENERATING',
  'LOW_EVIDENCE',
]);

function emptyStatusCounts(): Record<string, number> {
  return Object.fromEntries(STATUS_KEYS.map((status) => [status, 0]));
}

export interface PreparationQuestionState {
  questionType: string;
  status: string;
  nextRetryAt?: Date | string | null;
}

/**
 * Pure projection shared by queue reconciliation, ordering, admin APIs, and
 * per-exam summaries. A failed or merely validated question is never READY.
 */
export function summarizeLivePreparationProgress(
  examId: string,
  questionStates: PreparationQuestionState[],
  now: Date = new Date(),
): LivePreparationProgress {
  const statusCounts = emptyStatusCounts();
  let readyQuestions = 0;
  let retryableQuestions = 0;
  let waitingRetryQuestions = 0;
  let terminalFailedQuestions = 0;
  let nextEligibleAt: Date | null = null;

  for (const question of questionStates) {
    const status = question.status.toUpperCase() || 'PENDING';
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
    if (status === 'READY') {
      readyQuestions++;
      continue;
    }
    if (status === 'INVALID' || status === 'PERMANENT_LOW_EVIDENCE') {
      terminalFailedQuestions++;
      continue;
    }
    if (!RETRYABLE_STATUSES.has(status)) continue;

    const retryAt = question.nextRetryAt ? new Date(question.nextRetryAt) : null;
    if (retryAt && retryAt.getTime() > now.getTime()) {
      waitingRetryQuestions++;
      if (!nextEligibleAt || retryAt.getTime() < nextEligibleAt.getTime()) {
        nextEligibleAt = retryAt;
      }
    } else {
      retryableQuestions++;
    }
  }

  const totalQuestions = questionStates.length;
  return {
    examId,
    totalQuestions,
    readyQuestions,
    progressPct: totalQuestions > 0
      ? Math.round((readyQuestions / totalQuestions) * 100)
      : 0,
    remainingQuestions: Math.max(0, totalQuestions - readyQuestions),
    retryableQuestions,
    waitingRetryQuestions,
    terminalFailedQuestions,
    nextEligibleAt: nextEligibleAt?.toISOString() ?? null,
    statusCounts,
  };
}

/**
 * Read the current persisted preparation state for all requested exams in one
 * query, then derive each summary from those question rows. LATERAL lookups
 * ensure a duplicate historical preparation row cannot inflate progress.
 */
export async function getLivePreparationProgress(examId: string): Promise<LivePreparationProgress> {
  return (await getLivePreparationProgressForExams([examId])).get(examId)!;
}

export async function getLivePreparationProgressForExams(
  examIds: string[],
): Promise<Map<string, LivePreparationProgress>> {
  const ids = [...new Set(examIds)];
  const result = new Map<string, LivePreparationProgress>(
    ids.map((examId) => [
      examId,
      summarizeLivePreparationProgress(examId, []),
    ]),
  );
  if (ids.length === 0) return result;

  const pool = getSharedPool();
  const preparableTypes = [...PREPARATION_REQUIRED_TYPES];
  const { rows } = await pool.query<PreparationStatusRow>(
    `SELECT
       q.exam_id,
       q.question_type,
       CASE
         WHEN q.question_type IN ('mcq','true_false','fill_in_blank')
           THEN COALESCE(UPPER(ca.validation_status), 'PENDING')
         ELSE COALESCE(UPPER(op.preparation_status), 'PENDING')
       END AS preparation_status,
       CASE
         WHEN q.question_type IN ('mcq','true_false','fill_in_blank')
           THEN ca.next_retry_at
         ELSE op.next_retry_at
       END AS next_retry_at
     FROM public.exam_questions q
     LEFT JOIN LATERAL (
       SELECT validation_status, next_retry_at
       FROM public.exam_canonical_answers
       WHERE question_id = q.id
       ORDER BY updated_at DESC NULLS LAST
       LIMIT 1
     ) ca ON q.question_type IN ('mcq','true_false','fill_in_blank')
     LEFT JOIN LATERAL (
       SELECT preparation_status, next_retry_at
       FROM public.exam_open_preparations
       WHERE question_id = q.id
       ORDER BY updated_at DESC NULLS LAST
       LIMIT 1
     ) op ON q.question_type IN ('short_answer','essay','calculation')
     WHERE q.exam_id = ANY($1::text[])
       AND q.question_type = ANY($2::text[])
     ORDER BY q.exam_id, q.id`,
    [ids, preparableTypes],
  );

  const grouped = new Map<string, PreparationQuestionState[]>();
  for (const row of rows) {
    const states = grouped.get(row.exam_id) ?? [];
    states.push({
      questionType: row.question_type,
      status: row.preparation_status || 'PENDING',
      nextRetryAt: row.next_retry_at,
    });
    grouped.set(row.exam_id, states);
  }

  for (const examId of ids) {
    result.set(
      examId,
      summarizeLivePreparationProgress(examId, grouped.get(examId) ?? []),
    );
  }
  return result;
}

/**
 * All incomplete extracted exams for admin visibility, whether or not they
 * currently have a retryable question or an active queue job.
 */
export async function getIncompletePreparationProgress(): Promise<LivePreparationProgress[]> {
  const pool = getSharedPool();
  const { rows } = await pool.query<{ exam_id: string }>(`
    SELECT exam_id
    FROM public.exam_records
    WHERE extraction_status = 'done' AND question_count > 0
    ORDER BY created_at ASC
  `);
  const progress = await getLivePreparationProgressForExams(rows.map((row) => row.exam_id));
  return [...progress.values()]
    .filter((entry) => entry.totalQuestions > entry.readyQuestions)
    .sort((a, b) => a.progressPct - b.progressPct);
}