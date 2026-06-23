/**
 * dbMigrations — safe idempotent startup migrations.
 *
 * Runs automatically at server startup (after listening).
 * All statements use IF NOT EXISTS — safe to run on every restart.
 * Never drops or alters existing columns.
 *
 * Order matters: parent tables must be created before child tables
 * that reference them via foreign keys.
 */
import { Pool } from 'pg';
import { logger } from './logger';

let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    const url = process.env['DATABASE_URL'];
    if (!url) throw new Error('DATABASE_URL not set');
    pool = new Pool({ connectionString: url, max: 3 });
  }
  return pool;
}

// ─── Rate Limit Buckets ───────────────────────────────────────────────────────
const CREATE_RATE_LIMIT_BUCKETS = `
  CREATE TABLE IF NOT EXISTS rate_limit_buckets (
    id              TEXT        PRIMARY KEY,
    tokens          REAL        NOT NULL DEFAULT 0,
    last_refill_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_rlb_updated ON rate_limit_buckets (updated_at);
`;

// ─── User Roles ───────────────────────────────────────────────────────────────
const CREATE_USER_ROLES = `
  CREATE TABLE IF NOT EXISTS user_roles (
    uid         TEXT        NOT NULL,
    role        TEXT        NOT NULL
                            CHECK (role IN ('student','teacher','moderator','admin','super_admin')),
    granted_by  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (uid, role)
  );
  CREATE INDEX IF NOT EXISTS idx_user_roles_uid ON user_roles (uid);
`;

// ─── PDF Upload Hashes ────────────────────────────────────────────────────────
const CREATE_PDF_UPLOAD_HASHES = `
  CREATE TABLE IF NOT EXISTS pdf_upload_hashes (
    sha256      TEXT        PRIMARY KEY,
    doc_id      TEXT        NOT NULL,
    owner_id    TEXT,
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_puh_owner ON pdf_upload_hashes (owner_id);
`;

// ─── DB Backup Log ────────────────────────────────────────────────────────────
const CREATE_BACKUP_LOG = `
  CREATE TABLE IF NOT EXISTS db_backup_log (
    id            SERIAL      PRIMARY KEY,
    started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at   TIMESTAMPTZ,
    status        TEXT        NOT NULL DEFAULT 'running'
                              CHECK (status IN ('running','success','failed')),
    file_path     TEXT,
    file_size_kb  INTEGER,
    error_message TEXT,
    verified      BOOLEAN     NOT NULL DEFAULT false,
    backup_data   BYTEA
  );
`;

// ─── Audit Log ────────────────────────────────────────────────────────────────
const CREATE_AUDIT_LOG = `
  CREATE TABLE IF NOT EXISTS audit_log (
    id            SERIAL      PRIMARY KEY,
    uid           TEXT,
    action        TEXT        NOT NULL,
    resource_type TEXT,
    resource_id   TEXT,
    metadata      JSONB,
    ip_address    TEXT,
    request_id    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_audit_uid        ON audit_log (uid);
  CREATE INDEX IF NOT EXISTS idx_audit_action     ON audit_log (action);
  CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_log (created_at DESC);
`;

// ─── Exam Records (parent) ────────────────────────────────────────────────────
const CREATE_EXAM_RECORDS = `
  CREATE TABLE IF NOT EXISTS exam_records (
    exam_id             TEXT        PRIMARY KEY,
    curriculum_doc_id   TEXT        NOT NULL,
    title               TEXT        NOT NULL,
    book_title          TEXT,
    subject             TEXT        NOT NULL,
    grade               TEXT        NOT NULL,
    country             TEXT        NOT NULL,
    track               TEXT,
    year                TEXT,
    exam_type           TEXT        NOT NULL DEFAULT 'final',
    organization        TEXT,
    owner_id            TEXT,
    visibility          TEXT        NOT NULL DEFAULT 'private',
    question_count      INTEGER     DEFAULT 0,
    extraction_status   TEXT        NOT NULL DEFAULT 'pending',
    extraction_error    TEXT,
    extracted_at        TIMESTAMPTZ,
    ocr_quality_score   INTEGER,
    extraction_attempts INTEGER,
    failure_reason      TEXT,
    ocr_diagnostics     JSONB,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS exam_records_curriculum_idx ON exam_records (curriculum_doc_id);
  CREATE INDEX IF NOT EXISTS exam_records_owner_idx      ON exam_records (owner_id);
  CREATE INDEX IF NOT EXISTS exam_records_status_idx     ON exam_records (extraction_status);
`;

// ─── Exam Questions (child of exam_records) ───────────────────────────────────
const CREATE_EXAM_QUESTIONS = `
  CREATE TABLE IF NOT EXISTS exam_questions (
    id                  TEXT        PRIMARY KEY,
    exam_id             TEXT        NOT NULL REFERENCES exam_records(exam_id) ON DELETE CASCADE,
    question            TEXT        NOT NULL,
    question_type       TEXT        NOT NULL DEFAULT 'mcq',
    options             JSONB,
    correct_answer      TEXT,
    explanation         TEXT,
    topic               TEXT,
    chapter             TEXT,
    subject             TEXT        NOT NULL,
    grade               TEXT        NOT NULL,
    country             TEXT        NOT NULL,
    year                TEXT,
    exam_type           TEXT,
    difficulty          TEXT,
    organization        TEXT,
    source_exam_id      TEXT        NOT NULL,
    source_exam_title   TEXT        NOT NULL,
    question_order      INTEGER,
    extracted_at        TIMESTAMPTZ DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS exam_questions_exam_idx    ON exam_questions (exam_id);
  CREATE INDEX IF NOT EXISTS exam_questions_type_idx    ON exam_questions (exam_id, question_type);
  CREATE INDEX IF NOT EXISTS exam_questions_search_idx  ON exam_questions (country, grade, subject, question_order);
`;

// ─── Exam Attempts (child of exam_records) ────────────────────────────────────
const CREATE_EXAM_ATTEMPTS = `
  CREATE TABLE IF NOT EXISTS exam_attempts (
    id              TEXT        PRIMARY KEY,
    exam_id         TEXT        NOT NULL REFERENCES exam_records(exam_id) ON DELETE CASCADE,
    student_id      TEXT        NOT NULL,
    status          TEXT        NOT NULL DEFAULT 'in_progress',
    total_questions INTEGER     DEFAULT 0,
    correct_count   INTEGER     DEFAULT 0,
    score_pct       NUMERIC(5,2),
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at    TIMESTAMPTZ
  );
  CREATE INDEX IF NOT EXISTS exam_attempts_exam_idx     ON exam_attempts (exam_id);
  CREATE INDEX IF NOT EXISTS exam_attempts_student_idx  ON exam_attempts (student_id);
  CREATE INDEX IF NOT EXISTS exam_attempts_status_idx   ON exam_attempts (student_id, status);
`;

// ─── Exam Answers (child of exam_attempts + exam_questions) ──────────────────
const CREATE_EXAM_ANSWERS = `
  CREATE TABLE IF NOT EXISTS exam_answers (
    id              TEXT        PRIMARY KEY,
    attempt_id      TEXT        NOT NULL REFERENCES exam_attempts(id) ON DELETE CASCADE,
    question_id     TEXT        NOT NULL REFERENCES exam_questions(id),
    student_answer  TEXT,
    is_correct      BOOLEAN,
    grading_method  TEXT        DEFAULT 'pending',
    ai_feedback     TEXT,
    answered_at     TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS exam_answers_attempt_idx   ON exam_answers (attempt_id);
  CREATE INDEX IF NOT EXISTS exam_answers_question_idx  ON exam_answers (question_id);
`;

// ─── Weakness Snapshots (independent) ────────────────────────────────────────
const CREATE_WEAKNESS_SNAPSHOTS = `
  CREATE TABLE IF NOT EXISTS weakness_snapshots (
    id           SERIAL      PRIMARY KEY,
    student_id   TEXT        NOT NULL,
    country      TEXT        NOT NULL,
    grade        TEXT        NOT NULL,
    subject      TEXT        NOT NULL,
    topic_scores JSONB       NOT NULL DEFAULT '{}'::jsonb,
    total_exams  INTEGER     DEFAULT 0,
    last_updated TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (student_id, country, grade, subject)
  );
  CREATE INDEX IF NOT EXISTS weakness_snapshots_student_idx ON weakness_snapshots (student_id);
`;

export async function runStartupMigrations(): Promise<void> {
  const db = getPool();
  try {
    await db.query(CREATE_RATE_LIMIT_BUCKETS);
    await db.query(CREATE_USER_ROLES);
    await db.query(CREATE_PDF_UPLOAD_HASHES);
    await db.query(CREATE_BACKUP_LOG);
    await db.query(CREATE_AUDIT_LOG);
    await db.query(CREATE_EXAM_RECORDS);
    await db.query(CREATE_EXAM_QUESTIONS);
    await db.query(CREATE_EXAM_ATTEMPTS);
    await db.query(CREATE_EXAM_ANSWERS);
    await db.query(CREATE_WEAKNESS_SNAPSHOTS);
    // Backward-compatible: add backup_data column if missing on existing installs
    await db.query(`ALTER TABLE db_backup_log ADD COLUMN IF NOT EXISTS backup_data BYTEA`);
    logger.info('dbMigrations: all startup tables created/verified');
  } catch (err) {
    logger.error({ err }, 'dbMigrations: migration failed');
  }
}

// ─── Exported raw pool for rate limiter / RBAC ───────────────────────────────
export { getPool as getMigrationPool };
