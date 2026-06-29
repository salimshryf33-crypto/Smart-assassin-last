---
name: Neon Migration
description: Production database migrated from Replit Helium to Neon PostgreSQL. Key facts for future sessions.
---

# Neon Migration

**Why:** User wants a platform-agnostic global app; Neon PostgreSQL works on any hosting.

**Production DB:** Neon PostgreSQL — `DATABASE_URL` secret (already active).

**Old DB:** Replit Helium (`PGHOST=helium`, `PGDATABASE=heliumdb`) — still accessible via `executeSql` (replit_database target) but no longer used by the app.

**Migration date:** 2026-06-29

**What was migrated:** 13 tables, 402 rows total.
- `curriculum_documents`: 6 rows (biology×3, chemistry×2, physics×1)
- `curriculum_chunks`: 207 rows (embeddings intact)
- `exam_records`: 3 rows
- `exam_questions`: 185 rows
- `audit_log`: 1 row
- All other tables: 0 rows

**Backup:** `artifacts/api-server/data/backups/helium-backup-2026-06-28T20-25-07-831Z.sql`

**Migration script:** `scripts/migrate-to-neon.mjs` — reusable if needed again.

**How to apply:** Run `node scripts/migrate-to-neon.mjs` (reads from PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE, writes to DATABASE_URL).

**Schema management:** All 13 tables created by `runStartupMigrations()` in `dbMigrations.ts` (idempotent, runs on every server startup). No separate Drizzle push needed for runtime tables.

**Drizzle schema tables** (in `lib/db/src/schema/`): exam_records, exam_questions, exam_attempts, exam_answers, weakness_snapshots — these are also covered by dbMigrations.ts, so startup handles everything.

**How to apply to avoid:** If DATABASE_URL ever changes again, re-run `scripts/migrate-to-neon.mjs` with the old PG* env vars pointing to the old source.
