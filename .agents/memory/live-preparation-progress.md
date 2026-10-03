---
name: Live Preparation Progress
description: Project rule for progress reporting and ordering exam-preparation jobs.
---

## Rule
Derive every user-facing preparation percentage, remaining count, and scheduler progress ordering from persisted per-question statuses through the shared live summary. Job counters are operational snapshots only. `READY` is the only status counted as usable; `VALIDATED` is not yet prepared.

**Why:** Persisted job counters can be null or stale, and validation alone does not mean an answer is ready for use.

**How to apply:** When adding a preparation progress display, queue order, or remaining-question count, use the shared live summary instead of `exam_preparation_jobs` counters.