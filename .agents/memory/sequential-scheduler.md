---
name: Sequential Preparation Scheduler
description: Phase 4B — adaptive sequential scheduler that finishes one exam before starting the next, maximising completed exams.
---

# Sequential Preparation Scheduler

## Rule
ONE exam is prepared at a time to completion before the scheduler advances to the next exam. Never spread AI quota across multiple partial exams simultaneously.

## Why
Free-tier Gemini (~20 req/day) was being split across all pending exams, leaving every exam partially prepared. Sequential ordering ensures exams reach READY status one at a time, maximising publishable exams per quota cycle.

## How to apply
The scheduler is in `retryScheduler.ts`. The tick loop calls `getNextExamForSequentialScheduler()` from `preparationQueue.ts` to pick ONE job, runs `runValidationForExam()` to completion, then chains to the next exam if capacity remains. Stops cleanly on `DailyQuotaExhaustedError`.

## Ordering (exam priority within queue)
1. `running` jobs first — never abandon mid-exam
2. `priority ASC` — manual priority (lower number = higher urgency)
3. `ready_questions / total_questions DESC` — most-complete exam next (fastest to finish)
4. `created_at ASC` — oldest as tiebreaker

## Key functions
- `getNextExamForSequentialScheduler()` — picks the single best exam (preparationQueue.ts)
- `getOrderedQueueSnapshot()` — ordered queue for dashboard display (preparationQueue.ts)
- `MAX_EXAMS_PER_TICK = 50` — safety cap preventing infinite loop when all remaining questions are in retry windows

## Resume safety
`_runValidation` is idempotent — skips READY/INVALID/PERMANENT_LOW_EVIDENCE questions on re-entry. No new DB column needed for resume position; the skip-scan is O(n) with O(1) per completed question.

## Admin Dashboard
`GET /api/admin/prep-ops` now returns a `scheduler` field with:
- `mode: 'sequential'`
- `status: 'running' | 'idle' | 'quota_paused'`
- `activeExam` — current job details (progressPct, remainingQuestions, priority)
- `queueOrder` — up to 20 entries ordered by the same priority rules
- `nextExamPreview` — first exam after the active one

Frontend: `SchedulerStatePanel` component in `AdminDashboard.tsx` inside `PrepOpsSection`. Uses `data.scheduler` (optional field on `PrepOpsDashboard`).

## What was NOT changed
OCR, RAG, retrieval, canonical answer logic, open preparation packages, validation rules, grading engine, student APIs, DB schema.
