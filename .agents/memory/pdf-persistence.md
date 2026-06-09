---
name: PDF Persistence Architecture
description: Why local disk is unreliable for PDFs and how PostgreSQL bytea fixes it; what to watch for when changing storage.
---

## The Problem
`PDF_DIR = path.join(process.cwd(), 'data', 'pdfs')` resolves to local disk at
`/home/runner/workspace/artifacts/api-server/data/pdfs/`. This directory is wiped on:
- Git checkpoint restores (data/ is not git-tracked)
- Replit production deployments (ephemeral container)

## The Fix
`artifacts/api-server/src/lib/pdfPersistence.ts` — PostgreSQL `curriculum_pdfs` table (bytea):
- `savePdfToDb(docId, filePath)` — UPSERT on upload and reindex
- `restorePdfFromDb(docId, destPath)` — called by scheduler before resume if disk missing
- `deletePdfFromDb(docId)` — called by deleteDoc for cleanup
- Pool uses `DATABASE_URL` env var; SSL disabled for localhost

## Call Points
- `curriculumQueue.enqueueJob`: fire-and-forget save after disk copy
- `curriculumQueue.reindexDoc`: fire-and-forget save after disk copy
- `curriculumStorage.deleteDoc`: fire-and-forget delete
- `resumeScheduler.runScheduler`: sync disk check → async DB restore → then resume

## Legacy Bug Fixed
`pdfStoragePath` stored in index.json was a relative path for docs uploaded before
this fix (e.g. `"artifacts/api-server/data/pdfs/..."`). `resumeDoc` now always uses
`getPdfPath(docId)` (canonical absolute) instead of trusting the stored field.

**Why:** fs.existsSync resolves relative paths from CWD. Server CWD =
`/home/runner/workspace/artifacts/api-server`, making a relative
`artifacts/api-server/data/pdfs/...` resolve to a doubly-nested wrong path.

## Backward Compatibility
- PDFs uploaded BEFORE this fix are NOT in the DB. Scheduler logs WARN and
  tells the user to re-upload. Chunks, search, and chat retrieval are unaffected
  (those run from JSON files, never read the PDF after initial OCR).
- PDFs uploaded AFTER this fix survive any restart/checkpoint/deployment.

## Database Table
```sql
CREATE TABLE IF NOT EXISTS curriculum_pdfs (
  doc_id     TEXT        PRIMARY KEY,
  content    BYTEA       NOT NULL,
  byte_size  INTEGER     NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```
Managed directly with `pg.Pool` — not through Drizzle schema (avoids codegen churn).
