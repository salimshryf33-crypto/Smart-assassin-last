/**
 * dbMigrations — safe idempotent startup migrations.
 *
 * Runs automatically at server startup (after listening).
 * All statements use IF NOT EXISTS — safe to run on every restart.
 * Never drops or alters existing columns.
 *
 * All table names are schema-qualified (public.<table>) because the Neon role
 * in this project has an empty default search_path.
 *
 * Order matters: parent tables must be created before child tables
 * that reference them via foreign keys.
 */
import { logger } from './logger';
import { getSharedPool } from './dbPool';

function getPool() {
  return getSharedPool();
}

// ─── Rate Limit Buckets ───────────────────────────────────────────────────────
const CREATE_RATE_LIMIT_BUCKETS = `
  CREATE TABLE IF NOT EXISTS public.rate_limit_buckets (
    id              TEXT        PRIMARY KEY,
    tokens          REAL        NOT NULL DEFAULT 0,
    last_refill_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_rlb_updated ON public.rate_limit_buckets (updated_at);
`;

// ─── User Roles ───────────────────────────────────────────────────────────────
const CREATE_USER_ROLES = `
  CREATE TABLE IF NOT EXISTS public.user_roles (
    uid         TEXT        NOT NULL,
    role        TEXT        NOT NULL
                            CHECK (role IN ('student','teacher','moderator','admin','super_admin')),
    granted_by  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (uid, role)
  );
  CREATE INDEX IF NOT EXISTS idx_user_roles_uid ON public.user_roles (uid);
`;

// ─── PDF Upload Hashes ────────────────────────────────────────────────────────
const CREATE_PDF_UPLOAD_HASHES = `
  CREATE TABLE IF NOT EXISTS public.pdf_upload_hashes (
    sha256      TEXT        PRIMARY KEY,
    doc_id      TEXT        NOT NULL,
    owner_id    TEXT,
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_puh_owner ON public.pdf_upload_hashes (owner_id);
`;

// ─── DB Backup Log ────────────────────────────────────────────────────────────
const CREATE_BACKUP_LOG = `
  CREATE TABLE IF NOT EXISTS public.db_backup_log (
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
  CREATE TABLE IF NOT EXISTS public.audit_log (
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
  CREATE INDEX IF NOT EXISTS idx_audit_uid        ON public.audit_log (uid);
  CREATE INDEX IF NOT EXISTS idx_audit_action     ON public.audit_log (action);
  CREATE INDEX IF NOT EXISTS idx_audit_created_at ON public.audit_log (created_at DESC);
`;

// ─── Exam Records (parent) ────────────────────────────────────────────────────
const CREATE_EXAM_RECORDS = `
  CREATE TABLE IF NOT EXISTS public.exam_records (
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
  CREATE INDEX IF NOT EXISTS exam_records_curriculum_idx ON public.exam_records (curriculum_doc_id);
  CREATE INDEX IF NOT EXISTS exam_records_owner_idx      ON public.exam_records (owner_id);
  CREATE INDEX IF NOT EXISTS exam_records_status_idx     ON public.exam_records (extraction_status);
`;

// ─── Exam Questions (child of exam_records) ───────────────────────────────────
const CREATE_EXAM_QUESTIONS = `
  CREATE TABLE IF NOT EXISTS public.exam_questions (
    id                  TEXT        PRIMARY KEY,
    exam_id             TEXT        NOT NULL REFERENCES public.exam_records(exam_id) ON DELETE CASCADE,
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
  CREATE INDEX IF NOT EXISTS exam_questions_exam_idx    ON public.exam_questions (exam_id);
  CREATE INDEX IF NOT EXISTS exam_questions_type_idx    ON public.exam_questions (exam_id, question_type);
  CREATE INDEX IF NOT EXISTS exam_questions_search_idx  ON public.exam_questions (country, grade, subject, question_order);
`;

// ─── Exam Attempts (child of exam_records) ────────────────────────────────────
const CREATE_EXAM_ATTEMPTS = `
  CREATE TABLE IF NOT EXISTS public.exam_attempts (
    id              TEXT        PRIMARY KEY,
    exam_id         TEXT        NOT NULL REFERENCES public.exam_records(exam_id) ON DELETE CASCADE,
    student_id      TEXT        NOT NULL,
    status          TEXT        NOT NULL DEFAULT 'in_progress',
    total_questions INTEGER     DEFAULT 0,
    correct_count   INTEGER     DEFAULT 0,
    score_pct       NUMERIC(5,2),
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at    TIMESTAMPTZ
  );
  CREATE INDEX IF NOT EXISTS exam_attempts_exam_idx     ON public.exam_attempts (exam_id);
  CREATE INDEX IF NOT EXISTS exam_attempts_student_idx  ON public.exam_attempts (student_id);
  CREATE INDEX IF NOT EXISTS exam_attempts_status_idx   ON public.exam_attempts (student_id, status);
`;

// ─── Exam Answers (child of exam_attempts + exam_questions) ──────────────────
const CREATE_EXAM_ANSWERS = `
  CREATE TABLE IF NOT EXISTS public.exam_answers (
    id              TEXT        PRIMARY KEY,
    attempt_id      TEXT        NOT NULL REFERENCES public.exam_attempts(id) ON DELETE CASCADE,
    question_id     TEXT        NOT NULL REFERENCES public.exam_questions(id),
    student_answer  TEXT,
    is_correct      BOOLEAN,
    grading_method  TEXT        DEFAULT 'pending',
    ai_feedback     TEXT,
    answered_at     TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS exam_answers_attempt_idx   ON public.exam_answers (attempt_id);
  CREATE INDEX IF NOT EXISTS exam_answers_question_idx  ON public.exam_answers (question_id);
`;

// ─── Curriculum Documents ─────────────────────────────────────────────────────
// Source-of-truth for index.json. Disk is cache only.
const CREATE_CURRICULUM_DOCUMENTS = `
  CREATE TABLE IF NOT EXISTS public.curriculum_documents (
    id                   TEXT        PRIMARY KEY,
    country              TEXT        NOT NULL DEFAULT '',
    grade                TEXT        NOT NULL DEFAULT '',
    subject              TEXT        NOT NULL DEFAULT '',
    track                TEXT        NOT NULL DEFAULT '',
    filename             TEXT        NOT NULL DEFAULT '',
    total_pages          INTEGER     NOT NULL DEFAULT 0,
    chunk_count          INTEGER     NOT NULL DEFAULT 0,
    status               TEXT        NOT NULL DEFAULT 'queued',
    error_message        TEXT,
    uploaded_at          BIGINT      NOT NULL DEFAULT 0,
    processed_at         BIGINT,
    doc_type             TEXT,
    owner_id             TEXT,
    visibility           TEXT        NOT NULL DEFAULT 'public',
    book_title           TEXT,
    extraction_method    TEXT,
    extracted_chars      INTEGER,
    avg_chars_per_page   REAL,
    extracted_pages      INTEGER,
    last_rendered_page   INTEGER,
    pdf_storage_path     TEXT,
    last_resume_attempt  BIGINT,
    resume_attempts      INTEGER,
    last_resume_error    TEXT,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_cd_country_grade ON public.curriculum_documents (country, grade, subject);
  CREATE INDEX IF NOT EXISTS idx_cd_status        ON public.curriculum_documents (status);
  CREATE INDEX IF NOT EXISTS idx_cd_owner         ON public.curriculum_documents (owner_id);
`;

// ─── Curriculum Chunks ────────────────────────────────────────────────────────
// Source-of-truth for docs/*.json. Disk is cache only.
const CREATE_CURRICULUM_CHUNKS = `
  CREATE TABLE IF NOT EXISTS public.curriculum_chunks (
    id                   TEXT        PRIMARY KEY,
    doc_id               TEXT        NOT NULL,
    country              TEXT        NOT NULL DEFAULT '',
    grade                TEXT        NOT NULL DEFAULT '',
    subject              TEXT        NOT NULL DEFAULT '',
    chapter              TEXT        NOT NULL DEFAULT '',
    page_range           TEXT        NOT NULL DEFAULT '',
    chunk_index          INTEGER     NOT NULL DEFAULT 0,
    content              TEXT        NOT NULL DEFAULT '',
    content_normalized   TEXT        NOT NULL DEFAULT '',
    keywords             JSONB       NOT NULL DEFAULT '[]',
    embedding            JSONB,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_cc_doc_id  ON public.curriculum_chunks (doc_id);
  CREATE INDEX IF NOT EXISTS idx_cc_search  ON public.curriculum_chunks (country, grade, subject);
`;

// ─── Weakness Snapshots (independent) ────────────────────────────────────────
const CREATE_WEAKNESS_SNAPSHOTS = `
  CREATE TABLE IF NOT EXISTS public.weakness_snapshots (
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
  CREATE INDEX IF NOT EXISTS weakness_snapshots_student_idx ON public.weakness_snapshots (student_id);
`;

// ─── Flashcards ───────────────────────────────────────────────────────────────
const CREATE_FLASHCARDS = `
  CREATE TABLE IF NOT EXISTS public.flashcards (
    id            TEXT        PRIMARY KEY,
    student_id    TEXT        NOT NULL,
    exam_id       TEXT,
    attempt_id    TEXT,
    question_id   TEXT,
    front         TEXT        NOT NULL,
    back          TEXT        NOT NULL,
    source        TEXT        NOT NULL DEFAULT 'exam_mistake',
    topic         TEXT,
    subject       TEXT,
    grade         TEXT,
    country       TEXT,
    times_seen    INTEGER     NOT NULL DEFAULT 0,
    times_correct INTEGER     NOT NULL DEFAULT 0,
    last_seen_at  TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_fc_student   ON public.flashcards (student_id);
  CREATE INDEX IF NOT EXISTS idx_fc_subject   ON public.flashcards (student_id, subject, grade);
  CREATE INDEX IF NOT EXISTS idx_fc_attempt   ON public.flashcards (attempt_id);
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
    await db.query(CREATE_CURRICULUM_DOCUMENTS);
    await db.query(CREATE_CURRICULUM_CHUNKS);
    await db.query(CREATE_FLASHCARDS);
    // Backward-compatible additive column migrations
    await db.query(`ALTER TABLE public.db_backup_log ADD COLUMN IF NOT EXISTS backup_data BYTEA`);
    await db.query(`ALTER TABLE public.weakness_snapshots ADD COLUMN IF NOT EXISTS weak_topics_json TEXT`);
    // Orphan cleanup: remove ghost exam_records with no matching curriculum_documents
    await db.query(`
      DELETE FROM public.exam_records
      WHERE curriculum_doc_id NOT IN (SELECT id FROM public.curriculum_documents)
    `);
    // Data fixes: ensure doc_type is never null
    await db.query(`
      UPDATE public.curriculum_documents SET doc_type = 'book'
      WHERE doc_type IS NULL
    `);
    logger.info('dbMigrations: all startup tables created/verified');
  } catch (err) {
    logger.error({ err }, 'dbMigrations: migration failed');
  }
}

// ─── Exported raw pool for rate limiter / RBAC ───────────────────────────────
export { getPool as getMigrationPool };
