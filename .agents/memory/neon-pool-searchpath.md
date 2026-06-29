---
name: Neon search_path & shared pool
description: Neon role has empty default search_path; all SQL needs public. prefix; unified connection pool architecture and test suite.
---

## The rule
Every SQL statement in this codebase must use schema-qualified table names (`public.table_name`). The Neon role configured for this project has an empty default `search_path`, causing "no schema has been selected to create in" / "relation does not exist" errors when unqualified names are used.

**Why:** PostgreSQL uses `search_path` to resolve unqualified table names. Neon roles can have an empty search_path unlike typical local Postgres where `public` is always included.

**How to apply:** Any new table reference, CREATE TABLE, INSERT, SELECT, UPDATE, DELETE, ALTER TABLE must include `public.` prefix. This applies to ALL files: dbMigrations.ts, curriculumPersistence.ts, auditLog.ts, rbac.ts, pdfValidator.ts, pdfPersistence.ts, rateLimiter.ts, admin.ts routes, and any future SQL file.

## Shared pool (dbPool.ts)
Single `pg.Pool` singleton (`getSharedPool()`) replaces the old pattern of one pool per module. Settings: max 10, idleTimeout 30s, keepAlive true. All modules import `getSharedPool()`.

Do NOT use `new URL(connectionString)` to inject options like `--search_path=public` into the DATABASE_URL — it corrupts the URL for pg's parser and cancels all tests/connections. The correct fix is always explicit `public.` in SQL.

## Test suite
23-test suite at `artifacts/api-server/src/lib/backupScheduler.test.ts`. Run with `pnpm run test:backup`. All SQL in the test's `before` hook uses `public.db_backup_log`. Run tests before every server restart to catch regressions.

## Files with public.-qualified SQL (complete list as of fix)
- `src/lib/dbMigrations.ts` — all 13 CREATE TABLE + indexes + ALTER TABLE + DML
- `src/lib/curriculumPersistence.ts` — curriculum_documents + curriculum_chunks
- `src/lib/auditLog.ts` — audit_log
- `src/lib/pdfValidator.ts` — pdf_upload_hashes
- `src/lib/rbac.ts` — user_roles
- `src/lib/pdfPersistence.ts` — curriculum_pdfs
- `src/lib/backupScheduler.ts` — db_backup_log
- `src/middleware/rateLimiter.ts` — rate_limit_buckets
- `src/routes/admin.ts` — audit_log, rate_limit_buckets, user_roles, db_backup_log, exam_questions, exam_records
