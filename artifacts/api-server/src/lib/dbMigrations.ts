/**
 * dbMigrations — safe idempotent startup migrations for tables NOT in Drizzle schema.
 *
 * Run once at server startup (after listening).
 * All statements are IF NOT EXISTS / idempotent — safe to run on every restart.
 * Never drops or alters existing columns.
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
    id              TEXT        PRIMARY KEY,        -- "uid:action"
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

// ─── PDF Upload Hashes (for duplicate detection) ──────────────────────────────
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
    verified      BOOLEAN     NOT NULL DEFAULT false
  );
`;

export async function runStartupMigrations(): Promise<void> {
  const db = getPool();
  try {
    await db.query(CREATE_RATE_LIMIT_BUCKETS);
    await db.query(CREATE_USER_ROLES);
    await db.query(CREATE_PDF_UPLOAD_HASHES);
    await db.query(CREATE_BACKUP_LOG);
    logger.info('dbMigrations: all startup tables created/verified');
  } catch (err) {
    logger.error({ err }, 'dbMigrations: migration failed');
    // Non-fatal — server keeps running even if a table already exists with different constraints
  }
}

// ─── Exported raw pool for rate limiter / RBAC ───────────────────────────────
export { getPool as getMigrationPool };
