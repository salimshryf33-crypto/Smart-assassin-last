/**
 * examValidation/preparationQueue.ts
 *
 * Persistent preparation job queue backed by PostgreSQL (exam_preparation_jobs).
 *
 * Every exam gets exactly ONE active job row (enforced by unique partial index on
 * exam_id WHERE status IN ('pending','running','paused')).
 *
 * Priority levels:
 *   1 = oldest unfinished exams (backlog at startup)
 *   5 = newly uploaded exams    (default)
 *
 * Heartbeat: running jobs update heartbeat every HEARTBEAT_INTERVAL_MS.
 * Any job whose heartbeat is older than STALE_THRESHOLD_MS is assumed crashed
 * and reset to 'paused' so another worker can claim it.
 */

import { getSharedPool } from '../dbPool';
import { logger }        from '../logger';
import { v4 as uuidv4 } from 'uuid';
import {
  getLivePreparationProgressForExams,
  type LivePreparationProgress,
} from './livePreparationProgress';
import { disambiguateExamTitles } from './examDisplay';
import { PREPARATION_REQUIRED_TYPES } from '../questionTypeRegistry';

// ─── Constants ────────────────────────────────────────────────────────────────

export const HEARTBEAT_INTERVAL_MS = 30_000;   // update every 30 s
export const STALE_THRESHOLD_MS    = 90_000;   // job is stale if heartbeat > 90 s old

// ─── Types ────────────────────────────────────────────────────────────────────

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'paused';

export interface PreparationJob {
  id:              string;
  examId:          string;
  status:          JobStatus;
  priority:        number;
  totalQuestions:  number | null;
  readyQuestions:  number;
  workerId:        string | null;
  heartbeat:       Date | null;
  startedAt:       Date | null;
  completedAt:     Date | null;
  lastError:       string | null;
  createdAt:       Date;
  updatedAt:       Date;
}

// ─── Enqueue ──────────────────────────────────────────────────────────────────

/**
 * Enqueue an exam for preparation.
 * Idempotent: if an active job already exists for this exam, returns it unchanged.
 * Reuses the newest terminal job when work becomes eligible again, preserving
 * its progress snapshot and history rather than adding duplicate rows.
 */
export async function enqueueExam(
  examId:   string,
  priority: number = 5,
): Promise<PreparationJob> {
  const pool = getSharedPool();

  // Check for existing active job
  const { rows: existing } = await pool.query<DbRow>(
    `SELECT * FROM public.exam_preparation_jobs
     WHERE exam_id = $1 AND status IN ('pending','running','paused')
     LIMIT 1`,
    [examId],
  );
  if (existing[0]) {
    logger.debug({ examId, status: existing[0].status }, 'preparationQueue: job already active');
    return rowToJob(existing[0]);
  }

  const { rows: reopened } = await pool.query<DbRow>(
    `UPDATE public.exam_preparation_jobs
     SET status = 'pending',
         priority = $2,
         worker_id = NULL,
         heartbeat = NULL,
         updated_at = NOW()
     WHERE id = (
       SELECT id
       FROM public.exam_preparation_jobs
       WHERE exam_id = $1 AND status IN ('completed','failed')
       ORDER BY created_at DESC
       LIMIT 1
       FOR UPDATE
     )
       AND NOT EXISTS (
         SELECT 1 FROM public.exam_preparation_jobs
         WHERE exam_id = $1 AND status IN ('pending','running','paused')
       )
     RETURNING *`,
    [examId, priority],
  );
  if (reopened[0]) {
    logger.info(
      { examId, priority, jobId: reopened[0].id },
      'preparationQueue: reused terminal job for newly eligible work',
    );
    return rowToJob(reopened[0]);
  }

  const id = uuidv4();
  const { rows } = await pool.query<DbRow>(
    `INSERT INTO public.exam_preparation_jobs
       (id, exam_id, status, priority, created_at, updated_at)
     VALUES ($1, $2, 'pending', $3, NOW(), NOW())
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [id, examId, priority],
  );

  if (rows[0]) {
    logger.info({ examId, priority, jobId: id }, 'preparationQueue: job enqueued');
    return rowToJob(rows[0]);
  }

  // Conflict: another process inserted between our SELECT and INSERT — fetch it
  const { rows: refetch } = await pool.query<DbRow>(
    `SELECT * FROM public.exam_preparation_jobs
     WHERE exam_id = $1 AND status IN ('pending','running','paused')
     LIMIT 1`,
    [examId],
  );
  return rowToJob(refetch[0]!);
}

// ─── Claim next job ───────────────────────────────────────────────────────────

/**
 * Atomically claim the next pending/paused job for a worker.
 * Returns null if the queue is empty.
 * Ordering: lowest priority number first, then oldest created_at.
 */
export async function claimNextJob(workerId: string): Promise<PreparationJob | null> {
  const pool = getSharedPool();

  const { rows } = await pool.query<DbRow>(
    `UPDATE public.exam_preparation_jobs
     SET status    = 'running',
         worker_id = $1,
         heartbeat = NOW(),
         started_at = COALESCE(started_at, NOW()),
         updated_at = NOW()
     WHERE id = (
       SELECT id FROM public.exam_preparation_jobs
       WHERE status IN ('pending','paused')
       ORDER BY priority ASC, created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`,
    [workerId],
  );

  if (!rows[0]) return null;
  logger.debug({ jobId: rows[0].id, examId: rows[0].exam_id, workerId }, 'preparationQueue: job claimed');
  return rowToJob(rows[0]);
}

// ─── Heartbeat ────────────────────────────────────────────────────────────────

export async function updateHeartbeat(jobId: string): Promise<void> {
  const pool = getSharedPool();
  await pool.query(
    `UPDATE public.exam_preparation_jobs SET heartbeat = NOW(), updated_at = NOW() WHERE id = $1`,
    [jobId],
  );
}

// ─── Progress ────────────────────────────────────────────────────────────────

export async function updateProgress(
  jobId:          string,
  readyQuestions: number,
  totalQuestions: number,
): Promise<void> {
  const pool = getSharedPool();
  await pool.query(
    `UPDATE public.exam_preparation_jobs
     SET ready_questions = $2, total_questions = $3, heartbeat = NOW(), updated_at = NOW()
     WHERE id = $1`,
    [jobId, readyQuestions, totalQuestions],
  );
}

/**
 * Claim a specific pending/paused job before validation starts.
 *
 * This is deliberately separate from the queue ordering logic: the scheduler
 * selects by live progress, then the selected job is re-claimed here.
 */
export async function claimJob(jobId: string, workerId: string): Promise<boolean> {
  const pool = getSharedPool();
  const { rowCount } = await pool.query(
    `UPDATE public.exam_preparation_jobs
     SET status = 'running',
         worker_id = $2,
         heartbeat = NOW(),
         started_at = COALESCE(started_at, NOW()),
         updated_at = NOW()
     WHERE id = $1
       AND status IN ('pending','paused')`,
    [jobId, workerId],
  );
  return (rowCount ?? 0) > 0;
}

// ─── Complete / Fail / Pause ──────────────────────────────────────────────────

export async function completeJob(jobId: string, readyQuestions: number): Promise<void> {
  const pool = getSharedPool();
  await pool.query(
    `UPDATE public.exam_preparation_jobs
     SET status = 'completed', completed_at = NOW(), ready_questions = $2, updated_at = NOW()
     WHERE id = $1`,
    [jobId, readyQuestions],
  );
  logger.debug({ jobId, readyQuestions }, 'preparationQueue: job completed');
}

export async function failJob(jobId: string, error: string): Promise<void> {
  const pool = getSharedPool();
  await pool.query(
    `UPDATE public.exam_preparation_jobs
     SET status = 'failed', last_error = $2, updated_at = NOW()
     WHERE id = $1`,
    [jobId, error],
  );
  logger.warn({ jobId, error }, 'preparationQueue: job failed');
}

export async function pauseJob(jobId: string, reason?: string): Promise<void> {
  const pool = getSharedPool();
  await pool.query(
    `UPDATE public.exam_preparation_jobs
     SET status = 'paused',
         last_error = $2,
         worker_id = NULL,
         heartbeat = NULL,
         updated_at = NOW()
     WHERE id = $1`,
    [jobId, reason ?? null],
  );
  logger.debug({ jobId, reason }, 'preparationQueue: job paused (quota)');
}

// ─── Stale job recovery ───────────────────────────────────────────────────────

/**
 * Find running jobs whose heartbeat has expired and reset them to 'paused'
 * so the global scheduler can claim them again.
 */
export async function recoverStaleJobs(): Promise<number> {
  const pool = getSharedPool();
  const staleThreshold = new Date(Date.now() - STALE_THRESHOLD_MS);

  const { rows } = await pool.query<{ id: string; exam_id: string }>(
    `UPDATE public.exam_preparation_jobs
     SET status = 'paused', worker_id = NULL, heartbeat = NULL, updated_at = NOW()
     WHERE status = 'running'
       AND (heartbeat IS NULL OR heartbeat < $1)
     RETURNING id, exam_id`,
    [staleThreshold],
  );

  if (rows.length > 0) {
    logger.warn(
      { count: rows.length, examIds: rows.map(r => r.exam_id) },
      'preparationQueue: recovered stale jobs',
    );
  }
  return rows.length;
}

// ─── Query ────────────────────────────────────────────────────────────────────

export async function getJobByExamId(examId: string): Promise<PreparationJob | null> {
  const pool = getSharedPool();
  const { rows } = await pool.query<DbRow>(
    `SELECT * FROM public.exam_preparation_jobs
     WHERE exam_id = $1
     ORDER BY CASE WHEN status IN ('pending','running','paused') THEN 0 ELSE 1 END,
              created_at DESC
     LIMIT 1`,
    [examId],
  );
  return rows[0] ? rowToJob(rows[0]) : null;
}

export interface QueueOverview {
  pending:   number;
  running:   number;
  paused:    number;
  completed: number;
  failed:    number;
  total:     number;
}

export interface PreparationQueueSortCandidate {
  status: string;
  priority: number;
  progressPct: number;
  createdAt: Date | string;
}

export function comparePreparationQueueCandidates(
  a: PreparationQueueSortCandidate,
  b: PreparationQueueSortCandidate,
): number {
  const runningDiff = Number(b.status === 'running') - Number(a.status === 'running');
  if (runningDiff !== 0) return runningDiff;
  if (a.priority !== b.priority) return a.priority - b.priority;
  if (a.progressPct !== b.progressPct) return b.progressPct - a.progressPct;
  return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
}

export async function getQueueOverview(): Promise<QueueOverview> {
  const pool = getSharedPool();
  const { rows } = await pool.query<{ status: string; cnt: string }>(
    `SELECT status, COUNT(*) AS cnt FROM public.exam_preparation_jobs GROUP BY status`,
  );
  const map: Record<string, number> = {};
  for (const r of rows) map[r.status] = parseInt(r.cnt, 10);
  return {
    pending:   map['pending']   ?? 0,
    running:   map['running']   ?? 0,
    paused:    map['paused']    ?? 0,
    completed: map['completed'] ?? 0,
    failed:    map['failed']    ?? 0,
    total:     Object.values(map).reduce((a, b) => a + b, 0),
  };
}

export async function listPendingJobs(limit = 50): Promise<PreparationJob[]> {
  const pool = getSharedPool();
  const { rows } = await pool.query<DbRow>(
    `SELECT * FROM public.exam_preparation_jobs
     WHERE status IN ('pending','running','paused')
     ORDER BY priority ASC, created_at ASC
     LIMIT $1`,
    [limit],
  );
  return rows.map(rowToJob);
}

// ─── Sequential Scheduler helpers ────────────────────────────────────────────

/**
 * Returns the single best exam for the sequential scheduler to process next.
 *
 * Ordering rules (sequential strategy — finish exams, not spread capacity):
 *   1. Running jobs first  — never abandon mid-exam
 *   2. Priority ASC        — lowest number = highest urgency
 *   3. Ready % DESC        — most-complete exam first (finish it fastest)
 *   4. Created-at ASC      — oldest first as tiebreaker
 */
export async function getNextExamForSequentialScheduler(
  sharedProgress?: ReadonlyMap<string, LivePreparationProgress>,
): Promise<PreparationJob | null> {
  const pool = getSharedPool();
  const { rows } = await pool.query<DbRow>(
    `SELECT * FROM public.exam_preparation_jobs
     WHERE status IN ('running','pending','paused')
     ORDER BY CASE WHEN status = 'running' THEN 0 ELSE 1 END ASC, priority ASC, created_at ASC`,
  );
  if (!rows[0]) return null;

  const progressByExam = await withProgressForRows(rows, sharedProgress);
  const candidates = rows
    .map((row) => ({ row, progress: progressByExam.get(row.exam_id)! }))
    .filter(({ row, progress }) => row.status === 'running' || progress.retryableQuestions > 0);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => comparePreparationQueueCandidates(
    {
      status: a.row.status,
      priority: a.row.priority,
      progressPct: a.progress.progressPct,
      createdAt: a.row.created_at,
    },
    {
      status: b.row.status,
      priority: b.row.priority,
      progressPct: b.progress.progressPct,
      createdAt: b.row.created_at,
    },
  ));

  const selected = candidates[0];
  const job = rowToJob(selected.row);
  // Internal scheduler context uses live values; persisted job counters remain
  // operational snapshots and are never used to calculate display progress.
  job.totalQuestions = selected.progress.totalQuestions;
  job.readyQuestions = selected.progress.readyQuestions;
  return job;
}

export interface QueueOrderEntry {
  job:      PreparationJob;
  examTitle: string | null;
  readyPct: number;
  remainingQuestions: number;
  retryableQuestions: number;
  waitingRetryQuestions: number;
  terminalFailedQuestions: number;
  nextEligibleAt: string | null;
  position: number;
}

/**
 * Returns the full ordered queue for dashboard display.
 * Same ordering as getNextExamForSequentialScheduler.
 */
export async function getOrderedQueueSnapshot(
  limit = 20,
  sharedProgress?: ReadonlyMap<string, LivePreparationProgress>,
): Promise<QueueOrderEntry[]> {
  const pool = getSharedPool();
  const { rows } = await pool.query<DbRow & { exam_title: string | null; exam_created_at: Date | null }>(
    `SELECT j.*, r.title AS exam_title
            ,r.created_at AS exam_created_at
     FROM public.exam_preparation_jobs j
     LEFT JOIN public.exam_records r ON r.exam_id = j.exam_id
     WHERE j.status IN ('running','pending','paused')
     ORDER BY CASE WHEN j.status = 'running' THEN 0 ELSE 1 END ASC, j.priority ASC, j.created_at ASC`,
  );

  const titles = disambiguateExamTitles(rows.map((row) => ({
    examId: row.exam_id,
    title: row.exam_title,
    createdAt: row.exam_created_at,
  })));
  const progressByExam = await withProgressForRows(rows, sharedProgress);
  const entries = rows.map((row) => {
    const job       = rowToJob(row);
    const progress  = progressByExam.get(row.exam_id)!;
    job.totalQuestions = progress.totalQuestions;
    job.readyQuestions = progress.readyQuestions;
    return {
      job,
      examTitle:          titles.get(row.exam_id) ?? row.exam_title,
      readyPct:           progress.progressPct,
      remainingQuestions: progress.remainingQuestions,
      retryableQuestions: progress.retryableQuestions,
      waitingRetryQuestions: progress.waitingRetryQuestions,
      terminalFailedQuestions: progress.terminalFailedQuestions,
      nextEligibleAt: progress.nextEligibleAt,
      createdAt:          new Date(row.created_at).getTime(),
    };
  });

  entries.sort((a, b) => comparePreparationQueueCandidates(
    {
      status: a.job.status,
      priority: a.job.priority,
      progressPct: a.readyPct,
      createdAt: a.createdAt,
    },
    {
      status: b.job.status,
      priority: b.job.priority,
      progressPct: b.readyPct,
      createdAt: b.createdAt,
    },
  ));

  return entries.slice(0, limit).map((entry, index) => ({
    job: entry.job,
    examTitle: entry.examTitle,
    readyPct: entry.readyPct,
    remainingQuestions: entry.remainingQuestions,
    retryableQuestions: entry.retryableQuestions,
    waitingRetryQuestions: entry.waitingRetryQuestions,
    terminalFailedQuestions: entry.terminalFailedQuestions,
    nextEligibleAt: entry.nextEligibleAt,
    position: index + 1,
  }));
}

// ─── Initialise queue from existing exams ────────────────────────────────────

/**
 * Reconcile eligible work from the same live per-question snapshot used for
 * progress and ordering. Future retry windows and terminal failures are not
 * enqueued.
 */
export async function reconcilePreparationQueue(): Promise<number> {
  const pool = getSharedPool();
  const { rows } = await pool.query<{ exam_id: string }>(
    `SELECT DISTINCT q.exam_id
     FROM public.exam_questions q
     JOIN public.exam_records r ON r.exam_id = q.exam_id
     WHERE r.extraction_status = 'done'
       AND r.question_count > 0
       AND q.question_type = ANY($1::text[])
     ORDER BY q.exam_id`,
    [[...PREPARATION_REQUIRED_TYPES]],
  );
  const progressByExam = await getLivePreparationProgressForExams(rows.map((row) => row.exam_id));
  let enqueued = 0;
  for (const { exam_id } of rows) {
    if ((progressByExam.get(exam_id)?.retryableQuestions ?? 0) > 0) {
      await enqueueExam(exam_id, 1);
      enqueued++;
    }
  }

  return enqueued;
}

export async function initPreparationQueue(): Promise<void> {
  const enqueued = await reconcilePreparationQueue();
  if (enqueued > 0) {
    logger.info({ enqueued }, 'preparationQueue: init — reconciled eligible backlog exams');
  } else {
    logger.info('preparationQueue: init — no eligible backlog exams');
  }
}

async function withProgressForRows(
  rows: Array<{ exam_id: string }>,
  sharedProgress?: ReadonlyMap<string, LivePreparationProgress>,
): Promise<Map<string, LivePreparationProgress>> {
  const missingIds = [...new Set(rows
    .map((row) => row.exam_id)
    .filter((examId) => !sharedProgress?.has(examId)))];
  const missingProgress = await getLivePreparationProgressForExams(missingIds);
  const progressByExam = new Map(sharedProgress ?? []);
  for (const [examId, progress] of missingProgress) progressByExam.set(examId, progress);
  return progressByExam;
}

// ─── DB row → domain ──────────────────────────────────────────────────────────

interface DbRow {
  id:              string;
  exam_id:         string;
  status:          string;
  priority:        number;
  total_questions: number | null;
  ready_questions: number;
  worker_id:       string | null;
  heartbeat:       Date | null;
  started_at:      Date | null;
  completed_at:    Date | null;
  last_error:      string | null;
  created_at:      Date;
  updated_at:      Date;
}

function rowToJob(row: DbRow): PreparationJob {
  return {
    id:             row.id,
    examId:         row.exam_id,
    status:         row.status as JobStatus,
    priority:       row.priority,
    totalQuestions: row.total_questions,
    readyQuestions: row.ready_questions,
    workerId:       row.worker_id,
    heartbeat:      row.heartbeat,
    startedAt:      row.started_at,
    // Preserve the historic DB timestamp, but don't expose it as the current
    // completion when the same job row is reactivated.
    completedAt:    row.status === 'completed' ? row.completed_at : null,
    lastError:      row.last_error,
    createdAt:      row.created_at,
    updatedAt:      row.updated_at,
  };
}
