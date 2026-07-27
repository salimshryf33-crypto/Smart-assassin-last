---
name: Grading Audit Pipeline
description: Unified audit logging for every grading outcome — all 6 question types, all 4 paths, into existing validation_audit_log table.
---

## What was built

Phase 3 Part 2: unified grading audit pipeline wired into the existing observability layer.

## Architecture

### No new tables or schema changes
All grading events go into the existing `public.validation_audit_log` table via the existing `logAuditEvent()` function. The 12 required fields are stored in the JSONB `payload` column.

### New file: `src/lib/observability/gradingAuditLogger.ts`
- `GRADING_RULES_VERSION = '3.0.0'` — bump on any scoring logic change
- `GradingOutcomeEvent` interface — typed wrapper for all 12 required fields
- `deriveFinalClassification(isCorrect, scoreRatio, gradingMethod)` — maps result to 'correct' | 'partial' | 'incorrect' | 'skipped' | 'pending_preparation'
- `logGradingOutcome(evt)` → calls `logAuditEvent({ event: 'grading_outcome', ... })` — fire-and-forget, never throws

### correctionEngine/index.ts changes
- Removed local `getCanonicalStatus()` helper (queried only status); replaced with `canonicalAnswerStore.getByQuestionId()` (same DB call, but returns version + confidence for audit)
- Added `const examId = firstQ?.examId ?? ''` once at top — shared across all question iterations
- Added `const questionStart = Date.now()` at start of each question's grading cycle
- `logGradingOutcome()` called at every grading path exit:
  - **deterministic** — MCQ/TF/fill_in_blank, READY, gradingMethod=exact/skipped
  - **open_package** — short_answer/calculation/essay, READY, gradingMethod=exact/skipped
  - **pending_preparation (canonical)** — canonical not READY; severity=warn
  - **pending_preparation (open)** — open prep not READY; severity=warn
  - **unknown_type** — unregistered question type; severity=warn

### 12 required fields per event
| Field | Location | Source |
|---|---|---|
| examId | top-level column | firstQ.examId |
| questionId | top-level column | question.id |
| questionType | payload | question.questionType |
| gradingStrategy | payload | 'deterministic'/'open_package'/'pending_preparation'/'unknown_type' |
| preparationSource | payload | 'canonical_answers'/'open_preparations'/null |
| preparationVersion | payload | canonical.retrievalVersion or openPrep.retrievalVersion |
| rulesVersion | payload | GRADING_RULES_VERSION constant |
| confidence | payload | canonical.confidence or openPrep.confidence |
| preparationStatus | payload | canonical.validationStatus or openPrep.preparationStatus |
| finalClassification | payload | deriveFinalClassification() or 'pending_preparation' |
| gradingDuration | duration_ms column | Date.now() - questionStart |
| timestamp | created_at column | auto by auditLogger |

### New admin endpoints (admin.ts)
- `GET /api/admin/grading-audit` — raw grading_outcome rows; filters: examId, questionId, attemptId, finalClassification, limit
- `GET /api/admin/grading-audit?examId=X&summary=1` — aggregate stats: byClassification, byStrategy, pendingPreparation list
- `GET /api/admin/validation-audit` — all validation_audit_log events (was orphaned in metricsQueries.ts, now exposed)

### metricsQueries.ts additions
- `getGradingAuditLog(filters)` — filtered query on validation_audit_log WHERE event='grading_outcome'
- `getGradingAuditSummary(examId)` — 3 parallel queries: classification counts, strategy stats, pending question list

## Rules
- `GRADING_RULES_VERSION` must be bumped any time scoring formula, normalisation rules, or isCorrect threshold changes
- Already-graded answers (idempotency skip path) do NOT emit audit events — they are not real grading runs
- Questions with no matching question record also do NOT emit — data integrity error, not a grading outcome
- The `logGradingOutcome()` call always goes AFTER the `examSolverStore.updateAnswer()` persist — audit follows commit
