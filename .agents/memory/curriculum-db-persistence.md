---
name: Curriculum DB Persistence
description: PostgreSQL as source of truth for curriculum metadata (index.json + docs/*.json); disk is cache only.
---

## Rule
`curriculum_documents` and `curriculum_chunks` tables are the authoritative store.
Disk (`data/curriculum/index.json`, `data/curriculum/docs/*.json`) is ephemeral cache only.

**Why:** Disk is lost on container rebuild; OCR processing costs Gemini quota (free = 20 req/day). DB survives indefinitely as long as DATABASE_URL stays the same.

## How to apply
- `curriculumPersistence.ts` — all DB operations live here (upsertDocMetaToDB, saveChunksToDB, deleteDocFromDB, restoreCurriculumFromDB).
- `curriculumStorage.ts` — disk writes unchanged; each write function also calls the DB counterpart as fire-and-forget (`.catch(logger.error)`). Never block disk path.
- `index.ts` startup chain (in order): `runStartupMigrations` → `restoreCurriculumFromDB` → `migrateIndex` + `relabelChapters`. The latter two run inside `.then()` of the restore promise.
- First run (DB empty): seeds DB from disk automatically.
- Subsequent runs (disk missing): restores disk from DB automatically.

## Verified
- 6 docs, 208 chunks seeded on first startup. expected_chunks == actual chunks in PG.
- `appendChunks` (used during OCR resume) is NOT separately hooked — it calls `saveChunks` internally after append, which triggers DB sync.
