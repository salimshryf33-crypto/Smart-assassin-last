---
name: Preparation-First Exam Pipeline
description: Phase 6 — Gemini runs only during background preparation, never during grading. All MCQ grading is PostgreSQL-only.
---

## Rule
Gemini is called ONLY during background preparation (validationPipeline). Grading is PostgreSQL-only.

## Tables Added (all additive)
- `exam_records.preparation_status` — pending/preparing/ready/partially_ready/blocked/failed
- `exam_records.preparation_started_at/completed_at/worker_id/heartbeat` columns
- `public.exam_preparation_jobs` — persistent preparation queue with priority, heartbeat, status
- `public.exam_dlq` — Dead Letter Queue for PERMANENT_LOW_EVIDENCE questions

## New Files
- `examValidation/preparationQueue.ts` — CRUD for exam_preparation_jobs; enqueue/claim/heartbeat/stale recovery
- `examValidation/examPreparationStatus.ts` — compute + write preparation_status per exam
- `examValidation/deadLetterQueue.ts` — insert/list/resolve/retry for exam_dlq

## Modified Files
- `dbMigrations.ts` — Phase 6 migration block with backfill UPDATE
- `validationLock.ts` — added updateHeartbeat(jobId)
- `retryScheduler.ts` — throttling (MAX_CONCURRENT_EXAMS=10), stale recovery, ensureQueuedForEligibleExams
- `validationPipeline.ts` — heartbeat timer, job lifecycle (enqueue/complete/pause), DLQ insert on PERMANENT_LOW_EVIDENCE, syncPreparationStatus in finally block
- `correctionEngine/index.ts` — Grading Gate: checks canonical_status='READY' before MCQ grading; marks non-READY as gradingMethod='pending_preparation', isCorrect=null, excluded from scorePct denominator
- `routes/exam.ts` — 7 new admin endpoints under /api/exams/admin/preparation/* and /api/exams/admin/dlq/*
- `index.ts` — initPreparationQueue + syncAllPreparationStatuses in Stage C

## Startup Sequence (Stage C)
1. initPreparationQueue() — backlog exams enqueued with priority=1
2. syncAllPreparationStatuses() — backfill preparation_status from canonical answer states
3. runStartupValidation()
4. startRetryScheduler() — throttled + stale recovery

## Grading Gate
For DETERMINISTIC_TYPES (mcq, true_false): check canonical_status='READY' before grading.
If not READY → gradingMethod='pending_preparation', isCorrect=null, excluded from scorePct.
Open-ended: still use curriculum grader (no canonical answers needed).

**Why:** No Gemini at request time. Students get partial scores on available READY questions only.

**How to apply:** New question types requiring canonical answers must be added to DETERMINISTIC_TYPES and the grading gate applies automatically.
