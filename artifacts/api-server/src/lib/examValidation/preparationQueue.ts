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
 * If a completed/failed job exists, inserts a fresh one.
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
     SET status = 'paused', last_error = $2, updated_at = NOW()
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
     SET status = 'paused', worker_id = NULL, updated_at = NOW()
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
     ORDER BY created_at DESC LIMIT 1`,
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

// ─── Initialise queue from existing exams ────────────────────────────────────

/**
 * On startup, ensure every exam that still has unready questions has an
 * active preparation job. Old unfinished exams get priority=1 (highest).
 */
export async function initPreparationQueue(): Promise<void> {
  const pool = getSharedPool();

  // Find all exams that still have unready questions in EITHER preparation table:
  //   - exam_canonical_answers: MCQ, true_false, fill_in_blank
  //   - exam_open_preparations: short_answer, calculation, essay
  const { rows } = await pool.query<{ exam_id: string; has_active_job: boolean }>(
    `SELECT er.exam_id,
            EXISTS (
              SELECT 1 FROM public.exam_preparation_jobs epj
              WHERE epj.exam_id = er.exam_id AND epj.status IN ('pending','running','paused')
            ) AS has_active_job
     FROM public.exam_records er
     WHERE er.extraction_status = 'done'
       AND er.question_count > 0
       AND (
         -- MCQ/TF still unready in canonical answers
         EXISTS (
           SELECT 1 FROM public.exam_questions eq
           LEFT JOIN public.exam_canonical_answers ca ON ca.question_id = eq.id
           WHERE eq.exam_id = er.exam_id
             AND eq.question_type IN ('mcq','true_false','fill_in_blank')
             AND (ca.validation_status IS NULL OR ca.validation_status NOT IN ('READY','INVALID','PERMANENT_LOW_EVIDENCE'))
         )
         OR
         -- Open-ended types still unready in open preparations
         EXISTS (
           SELECT 1 FROM public.exam_questions eq
           LEFT JOIN public.exam_open_preparations op ON op.question_id = eq.id
           WHERE eq.exam_id = er.exam_id
             AND eq.question_type IN ('short_answer','essay','calculation')
             AND (op.preparation_status IS NULL OR op.preparation_status NOT IN ('READY','INVALID','PERMANENT_LOW_EVIDENCE'))
         )
       )`,
  );

  let enqueued = 0;
  for (const row of rows) {
    if (!row.has_active_job) {
      await enqueueExam(row.exam_id, 1); // priority 1 = backlog (highest)
      enqueued++;
    }
  }

  if (enqueued > 0) {
    logger.info({ enqueued }, 'preparationQueue: init — enqueued backlog exams');
  } else {
    logger.info('preparationQueue: init — no backlog exams');
  }
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
    completedAt:    row.completed_at,
    lastError:      row.last_error,
    createdAt:      row.created_at,
    updatedAt:      row.updated_at,
  };
}
