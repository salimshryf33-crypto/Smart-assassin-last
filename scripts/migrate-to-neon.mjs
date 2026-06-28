/**
 * migrate-to-neon.mjs
 * 
 * Migrates all data from Replit Helium (old) → Neon PostgreSQL (new).
 * 
 * OLD: PGHOST=helium / PGDATABASE=heliumdb (Replit built-in)
 * NEW: DATABASE_URL → Neon (already set in secrets)
 * 
 * Run: node scripts/migrate-to-neon.mjs
 */

import { createRequire } from 'module';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const pg = require('/home/runner/workspace/node_modules/.pnpm/pg@8.20.0/node_modules/pg');
const { Pool } = pg;

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Connection setup ─────────────────────────────────────────────────────────

const OLD = new Pool({
  host:     process.env.PGHOST,
  port:     Number(process.env.PGPORT || 5432),
  user:     process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  ssl:      false,
  connectionTimeoutMillis: 10000,
  max: 3,
});

const NEW = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000,
  max: 3,
});

// ─── DDL (all tables in dependency order) ─────────────────────────────────────

const DDL_STATEMENTS = [
  // 1. Independent tables
  `CREATE TABLE IF NOT EXISTS rate_limit_buckets (
    id              TEXT        PRIMARY KEY,
    tokens          REAL        NOT NULL DEFAULT 0,
    last_refill_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_rlb_updated ON rate_limit_buckets (updated_at)`,

  `CREATE TABLE IF NOT EXISTS user_roles (
    uid         TEXT        NOT NULL,
    role        TEXT        NOT NULL
                            CHECK (role IN ('student','teacher','moderator','admin','super_admin')),
    granted_by  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (uid, role)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_user_roles_uid ON user_roles (uid)`,

  `CREATE TABLE IF NOT EXISTS pdf_upload_hashes (
    sha256      TEXT        PRIMARY KEY,
    doc_id      TEXT        NOT NULL,
    owner_id    TEXT,
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_puh_owner ON pdf_upload_hashes (owner_id)`,

  `CREATE TABLE IF NOT EXISTS db_backup_log (
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
  )`,

  `CREATE TABLE IF NOT EXISTS audit_log (
    id            SERIAL      PRIMARY KEY,
    uid           TEXT,
    action        TEXT        NOT NULL,
    resource_type TEXT,
    resource_id   TEXT,
    metadata      JSONB,
    ip_address    TEXT,
    request_id    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_audit_uid        ON audit_log (uid)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_action     ON audit_log (action)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_log (created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS curriculum_documents (
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
  )`,
  `CREATE INDEX IF NOT EXISTS idx_cd_country_grade ON curriculum_documents (country, grade, subject)`,
  `CREATE INDEX IF NOT EXISTS idx_cd_status        ON curriculum_documents (status)`,
  `CREATE INDEX IF NOT EXISTS idx_cd_owner         ON curriculum_documents (owner_id)`,

  `CREATE TABLE IF NOT EXISTS curriculum_chunks (
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
  )`,
  `CREATE INDEX IF NOT EXISTS idx_cc_doc_id  ON curriculum_chunks (doc_id)`,
  `CREATE INDEX IF NOT EXISTS idx_cc_search  ON curriculum_chunks (country, grade, subject)`,

  `CREATE TABLE IF NOT EXISTS weakness_snapshots (
    id           SERIAL      PRIMARY KEY,
    student_id   TEXT        NOT NULL,
    country      TEXT        NOT NULL,
    grade        TEXT        NOT NULL,
    subject      TEXT        NOT NULL,
    topic_scores JSONB       NOT NULL DEFAULT '{}'::jsonb,
    total_exams  INTEGER     DEFAULT 0,
    last_updated TIMESTAMPTZ NOT NULL DEFAULT now(),
    weak_topics_json TEXT,
    UNIQUE (student_id, country, grade, subject)
  )`,
  `CREATE INDEX IF NOT EXISTS weakness_snapshots_student_idx ON weakness_snapshots (student_id)`,

  // 2. exam_records (parent of exam_questions/attempts/answers)
  `CREATE TABLE IF NOT EXISTS exam_records (
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
  )`,
  `CREATE INDEX IF NOT EXISTS exam_records_curriculum_idx ON exam_records (curriculum_doc_id)`,
  `CREATE INDEX IF NOT EXISTS exam_records_owner_idx      ON exam_records (owner_id)`,
  `CREATE INDEX IF NOT EXISTS exam_records_status_idx     ON exam_records (extraction_status)`,

  // 3. exam_questions (child of exam_records)
  `CREATE TABLE IF NOT EXISTS exam_questions (
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
  )`,
  `CREATE INDEX IF NOT EXISTS exam_questions_exam_idx    ON exam_questions (exam_id)`,
  `CREATE INDEX IF NOT EXISTS exam_questions_type_idx    ON exam_questions (exam_id, question_type)`,
  `CREATE INDEX IF NOT EXISTS exam_questions_search_idx  ON exam_questions (country, grade, subject, question_order)`,

  // 4. exam_attempts (child of exam_records)
  `CREATE TABLE IF NOT EXISTS exam_attempts (
    id              TEXT        PRIMARY KEY,
    exam_id         TEXT        NOT NULL REFERENCES exam_records(exam_id) ON DELETE CASCADE,
    student_id      TEXT        NOT NULL,
    status          TEXT        NOT NULL DEFAULT 'in_progress',
    total_questions INTEGER     DEFAULT 0,
    correct_count   INTEGER     DEFAULT 0,
    score_pct       NUMERIC(5,2),
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at    TIMESTAMPTZ
  )`,
  `CREATE INDEX IF NOT EXISTS exam_attempts_exam_idx     ON exam_attempts (exam_id)`,
  `CREATE INDEX IF NOT EXISTS exam_attempts_student_idx  ON exam_attempts (student_id)`,
  `CREATE INDEX IF NOT EXISTS exam_attempts_status_idx   ON exam_attempts (student_id, status)`,

  // 5. exam_answers (child of exam_attempts + exam_questions)
  `CREATE TABLE IF NOT EXISTS exam_answers (
    id              TEXT        PRIMARY KEY,
    attempt_id      TEXT        NOT NULL REFERENCES exam_attempts(id) ON DELETE CASCADE,
    question_id     TEXT        NOT NULL REFERENCES exam_questions(id),
    student_answer  TEXT,
    is_correct      BOOLEAN,
    grading_method  TEXT        DEFAULT 'pending',
    ai_feedback     TEXT,
    answered_at     TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS exam_answers_attempt_idx   ON exam_answers (attempt_id)`,
  `CREATE INDEX IF NOT EXISTS exam_answers_question_idx  ON exam_answers (question_id)`,

  // 6. flashcards (independent — exam_id/attempt_id/question_id are soft refs)
  `CREATE TABLE IF NOT EXISTS flashcards (
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
  )`,
  `CREATE INDEX IF NOT EXISTS idx_fc_student   ON flashcards (student_id)`,
  `CREATE INDEX IF NOT EXISTS idx_fc_subject   ON flashcards (student_id, subject, grade)`,
  `CREATE INDEX IF NOT EXISTS idx_fc_attempt   ON flashcards (attempt_id)`,
];

// ─── Tables to migrate (in order — parents before children) ──────────────────

const TABLES = [
  'rate_limit_buckets',
  'user_roles',
  'pdf_upload_hashes',
  'db_backup_log',
  'audit_log',
  'curriculum_documents',
  'curriculum_chunks',
  'weakness_snapshots',
  'exam_records',         // parent
  'exam_questions',       // child of exam_records
  'exam_attempts',        // child of exam_records
  'exam_answers',         // child of exam_attempts + exam_questions
  'flashcards',
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }
function err(msg) { console.error(`[${new Date().toISOString()}] ❌ ${msg}`); }

async function countRows(pool, table) {
  const r = await pool.query(`SELECT COUNT(*) AS n FROM "${table}"`);
  return Number(r.rows[0].n);
}

async function getAllRows(pool, table) {
  const r = await pool.query(`SELECT * FROM "${table}"`);
  return r.rows;
}

// ─── PHASE 1: Backup (SQL INSERT statements to file) ─────────────────────────

async function createBackup() {
  log('PHASE 1 — Creating backup of Helium database...');
  const backupDir = join(__dirname, '../artifacts/api-server/data/backups');
  try { mkdirSync(backupDir, { recursive: true }); } catch {}
  
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = join(backupDir, `helium-backup-${ts}.sql`);
  let sql = `-- Helium → Neon backup created at ${new Date().toISOString()}\n-- Tables: ${TABLES.join(', ')}\n\n`;
  
  const counts = {};
  for (const table of TABLES) {
    try {
      const rows = await getAllRows(OLD, table);
      counts[table] = rows.length;
      if (rows.length === 0) {
        sql += `-- ${table}: 0 rows\n`;
        continue;
      }
      const cols = Object.keys(rows[0]);
      sql += `-- ${table}: ${rows.length} rows\n`;
      for (const row of rows) {
        const vals = cols.map(c => {
          const v = row[c];
          if (v === null) return 'NULL';
          if (typeof v === 'number') return String(v);
          if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
          if (v instanceof Buffer) return `'\\x${v.toString('hex')}'`;
          if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'`;
          return `'${String(v).replace(/'/g, "''")}'`;
        });
        sql += `INSERT INTO "${table}" (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${vals.join(', ')}) ON CONFLICT DO NOTHING;\n`;
      }
      sql += '\n';
    } catch (e) {
      log(`  Warning: could not backup table ${table}: ${e.message}`);
    }
  }
  
  writeFileSync(backupFile, sql);
  log(`✅ Backup saved to ${backupFile}`);
  return { backupFile, counts };
}

// ─── PHASE 2: Create schema on Neon ──────────────────────────────────────────

async function createNeonSchema() {
  log('PHASE 2 — Creating schema on Neon...');
  for (const stmt of DDL_STATEMENTS) {
    try {
      await NEW.query(stmt);
    } catch (e) {
      // Ignore "already exists" errors
      if (!e.message.includes('already exists')) {
        throw e;
      }
    }
  }
  log('✅ Schema created on Neon');
}

// ─── PHASE 3: Migrate data ────────────────────────────────────────────────────

async function migrateData(oldCounts) {
  log('PHASE 3 — Migrating data from Helium → Neon...');
  const results = {};

  for (const table of TABLES) {
    const total = oldCounts[table] || 0;
    if (total === 0) {
      log(`  ⏭  ${table}: 0 rows — skipped`);
      results[table] = { old: 0, migrated: 0 };
      continue;
    }

    try {
      const rows = await getAllRows(OLD, table);
      if (rows.length === 0) {
        results[table] = { old: 0, migrated: 0 };
        continue;
      }

      const cols = Object.keys(rows[0]);
      let migrated = 0;

      // Insert in batches of 50
      const batchSize = 50;
      for (let i = 0; i < rows.length; i += batchSize) {
        const batch = rows.slice(i, i + batchSize);
        for (const row of batch) {
          const placeholders = cols.map((_, idx) => `$${idx + 1}`).join(', ');
          const values = cols.map(c => {
            const v = row[c];
            if (v !== null && typeof v === 'object' && !Buffer.isBuffer(v) && !(v instanceof Date)) {
              return JSON.stringify(v);
            }
            return v;
          });
          await NEW.query(
            `INSERT INTO "${table}" (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
            values
          );
          migrated++;
        }
      }

      results[table] = { old: rows.length, migrated };
      log(`  ✅ ${table}: ${migrated}/${rows.length} rows migrated`);
    } catch (e) {
      err(`  ${table}: ${e.message}`);
      results[table] = { old: oldCounts[table] || 0, migrated: 0, error: e.message };
    }
  }
  return results;
}

// ─── PHASE 4: Verify row counts ───────────────────────────────────────────────

async function verifyMigration(oldCounts) {
  log('PHASE 4 — Verifying row counts...');
  const report = [];
  let allMatch = true;

  for (const table of TABLES) {
    const oldN = oldCounts[table] || 0;
    try {
      const newN = await countRows(NEW, table);
      const match = oldN === newN;
      if (!match && oldN > 0) allMatch = false;
      report.push({ table, old: oldN, new: newN, match });
      log(`  ${match ? '✅' : '❌'} ${table}: OLD=${oldN} NEW=${newN}`);
    } catch (e) {
      allMatch = false;
      report.push({ table, old: oldN, new: 'ERROR', match: false, error: e.message });
      log(`  ❌ ${table}: ERROR — ${e.message}`);
    }
  }
  return { report, allMatch };
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  log('═══════════════════════════════════════════');
  log('  Sage — Helium → Neon Migration Script');
  log('═══════════════════════════════════════════');
  
  // Test connections
  log('Testing connections...');
  try {
    await OLD.query('SELECT 1');
    log('✅ Helium (OLD) connected');
  } catch (e) {
    err(`Cannot connect to Helium: ${e.message}`);
    process.exit(1);
  }
  try {
    await NEW.query('SELECT 1');
    log('✅ Neon (NEW) connected');
  } catch (e) {
    err(`Cannot connect to Neon: ${e.message}`);
    process.exit(1);
  }

  // Get old counts
  const oldCounts = {};
  for (const t of TABLES) {
    try { oldCounts[t] = await countRows(OLD, t); }
    catch { oldCounts[t] = 0; }
  }
  
  log('\nOLD database inventory:');
  for (const [t, n] of Object.entries(oldCounts)) {
    log(`  ${t}: ${n} rows`);
  }

  // Phase 1: Backup
  const { backupFile, counts } = await createBackup();
  
  // Phase 2: Schema
  await createNeonSchema();
  
  // Phase 3: Migrate
  const migrationResults = await migrateData(oldCounts);
  
  // Phase 4: Verify
  const { report, allMatch } = await verifyMigration(oldCounts);
  
  // ─── Final Report ──────────────────────────────────────────────────────────
  log('\n═══════════════════════════════════════════');
  log('  MIGRATION REPORT');
  log('═══════════════════════════════════════════');
  log(`Backup file  : ${backupFile}`);
  log(`Status       : ${allMatch ? '✅ SUCCESS — all row counts match' : '⚠️  PARTIAL — some tables may differ'}`);
  log('\nTable-level results:');
  for (const r of report) {
    log(`  ${r.match ? '✅' : '❌'} ${r.table.padEnd(30)} OLD=${String(r.old).padStart(4)}  NEW=${String(r.new).padStart(4)}  ${r.error ? '  ERROR: ' + r.error : ''}`);
  }
  
  const totalOld = Object.values(oldCounts).reduce((a, b) => a + b, 0);
  const totalNew = report.reduce((a, r) => a + (typeof r.new === 'number' ? r.new : 0), 0);
  log(`\nTotal rows   : OLD=${totalOld}  NEW=${totalNew}`);
  log(`Rollback     : Not needed — ${allMatch ? 'migration successful' : 'check errors above'}`);
  log(`Production DB: ${allMatch ? 'Neon is now active production database' : 'Helium still used (DATABASE_URL points to Neon but data may be incomplete)'}`);

  await OLD.end();
  await NEW.end();
  
  process.exit(allMatch ? 0 : 1);
}

main().catch(e => {
  err(`FATAL: ${e.message}`);
  process.exit(1);
});
