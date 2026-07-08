---
name: Phase 3 Validation Reliability Layer
description: Distributed lock, exponential retry, event-driven startup, retry scheduler added to the exam validation pipeline.
---

## Rule
Phase 3 is a pure extension of Phase 1/2. It adds reliability without changing business logic, public API contracts, or grading.

**Why:** Phase 2 validation review identified: infinite LOW_EVIDENCE retry loops consuming Gemini quota, timer-based startup race, no concurrent-worker protection.

**How to apply:** Never modify the 3 new files (retryPolicy, validationLock, retryScheduler) when working on other exam features — they are infrastructure, not business logic.

---

## New files (all under `lib/examValidation/`)
| File | Purpose |
|---|---|
| `retryPolicy.ts` | Pure: `shouldGiveUp(attemptCount)`, `computeNextRetryAt(attemptCount)`. MAX_VALIDATION_ATTEMPTS=4. Delays: 10min / 1hr / 24hr |
| `validationLock.ts` | `withExamLock(examId, fn)` — pg_try_advisory_lock(int, hashtext(examId)). Dedicated client per lock. LOCK_NAMESPACE=42001 (never change) |
| `retryScheduler.ts` | `startRetryScheduler()` — setInterval 5min. Queries idx_eca_retry partial index. In-process `running` flag prevents tick overlap |

---

## DB schema additions to `exam_canonical_answers`
```sql
attempt_count   INTEGER  NOT NULL DEFAULT 0
last_attempt_at TIMESTAMPTZ
next_retry_at   TIMESTAMPTZ
-- CHECK constraint updated: added 'PERMANENT_LOW_EVIDENCE'
-- New index: idx_eca_retry ON (next_retry_at, validation_status) WHERE next_retry_at IS NOT NULL
```
All migrations via ADD COLUMN IF NOT EXISTS — safe to re-run.

---

## Retry lifecycle
```
attempt_count 1 → LOW_EVIDENCE → next_retry_at = now + 10min
attempt_count 2 → LOW_EVIDENCE → next_retry_at = now + 1hr
attempt_count 3 → LOW_EVIDENCE → next_retry_at = now + 24hr
attempt_count 4 → PERMANENT_LOW_EVIDENCE → next_retry_at = null (done)
```
PERMANENT_LOW_EVIDENCE blocks publishing (getPublishReadiness treats it as non-READY).
INVALID and PERMANENT_LOW_EVIDENCE are permanent terminal states — never retried.

---

## Startup sequence (event-driven, no timers)
```
Promise.all([
  runStartupMigrations → restoreCurriculumFromDB → migrateIndex + relabelChapters,  // curriculumReady
  syncAndRecoverExams()   // examsReady
]).then(() => runStartupValidation()).then(() => startRetryScheduler())
```
Completely replaces the old 15-second `setTimeout`. Validation never races with curriculum restore.

---

## Advisory lock details
- `pg_try_advisory_lock(int4, int4)` — both args must be int4 (NOT bigint)
- `$1::int` (LOCK_NAMESPACE=42001) and `hashtext($2)` (returns int4 from examId string)
- Session-level: held by a dedicated `pool.connect()` client, released in `finally`
- Auto-released on connection close — no orphan locks
- Non-blocking: second worker gets `acquired: false` immediately, skips

---

## countUnready (smart, Phase 3)
Excludes READY, INVALID, PERMANENT_LOW_EVIDENCE, and LOW_EVIDENCE with future next_retry_at.
Only counts questions the startup scan can make progress on RIGHT NOW.

---

## Existing records (pre-Phase 3 compatibility)
- READY records: attempt_count=0, nextRetryAt=null — skipped immediately (correct)
- LOW_EVIDENCE records: attempt_count=0, nextRetryAt=null — retried on next startup scan (correct; get proper tracking on next attempt)
- VALIDATED records (stuck): attempt_count=0 — retried on next startup (correct)
