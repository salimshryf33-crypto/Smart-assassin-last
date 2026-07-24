---
name: Phase 2 — Open Preparation Pipeline
description: Architecture for preparing short_answer/calculation/essay questions offline; grading uses stored package (zero Gemini at grading time).
---

## Rule
`short_answer`, `calculation`, `essay` are prepared once via Gemini (during background preparation) and graded deterministically at grading time using the stored package. Gemini is NEVER called at grading time for these types.

**Why:** Eliminates per-student Gemini calls, makes grading fast and deterministic, and controls quota consumption.

## Key files
- `questionTypeRegistry.ts` — `requiresOpenPreparation: true` flags these 3 types; `OPEN_PREPARATION_TYPES` set derived from it.
- `examValidation/openPreparationDeriver.ts` — Gemini prompts produce typed packages (ShortAnswerPackage / CalculationPackage / EssayPackage).
- `examValidation/openPreparationStore.ts` — CRUD for `public.exam_open_preparations` table.
- `correctionEngine/openGrader.ts` — Pure deterministic scoring from stored package. Arabic-normalised string matching + numeric extraction (handles Arabic-Indic digits ٠-٩).
- `validationPipeline.ts` — Loop 2 runs after the canonical-answer loop; processes open-ended questions via `processOpenQuestion()`.
- `correctionEngine/index.ts` — `OPEN_PREPARATION_TYPES.has(type)` gate checked before falling through to curriculum grader. If READY → `gradeWithOpenPackage`. If not READY → `pending_preparation`.
- `examPreparationStatus.ts` — `syncPreparationStatus` queries BOTH `exam_canonical_answers` AND `exam_open_preparations` and aggregates totals.
- `preparationQueue.ts` — `initPreparationQueue` UNION checks both tables when scanning backlog.

## DB table
`public.exam_open_preparations` — Phase 7 migration. UNIQUE on `question_id`. Same status enum as canonical answers: PENDING/VALIDATED/READY/LOW_EVIDENCE/PERMANENT_LOW_EVIDENCE/INVALID.

## Confidence threshold
`OPEN_PREP_CONFIDENCE_THRESHOLD = 0.17` (≥1 of 6 evidence chunks must be relevant). Lower than MCQ threshold because open-ended types benefit from partial evidence.

## Grading scores
- `short_answer`: direct match (1.0) → 70% concept coverage + 30% keyword coverage.
- `calculation`: numeric extraction within tolerance (1.0) → concept partial credit (capped 0.4). Handles Arabic-Indic numerals.
- `essay`: 50% concept + 30% criteria + 20% scientific guard concepts. isCorrect = scoreRatio ≥ 0.5.

## gradingStrategy flag
`gradingStrategy: 'ai'` is KEPT for the 3 open types in the registry because Gemini IS used (at preparation time). This flag does not mean Gemini is called at grading time — that distinction is made by `requiresOpenPreparation`.

## Invariant change (registry test)
Old: `requiresPreparation implies requiresCanonicalAnswer`
New: `requiresPreparation implies (requiresCanonicalAnswer OR requiresOpenPreparation)`
Test #5 updated accordingly. 23 registry tests + 18 open-grader tests all pass.

## How to apply
- Any new open-ended type → add to registry with `requiresOpenPreparation: true`, `requiresPreparation: true`, `requiresCanonicalAnswer: false`.
- New package type → add interface to `openPreparationDeriver.ts` and grading branch to `openGrader.ts`.
- `gradeWithCurriculum` (live Gemini at grading time) remains in the codebase but is unreachable for all 6 known types.
