---
name: Exam Correction Bug Fixes
description: Three root causes of broken exam scoring found and fixed
---

## Bug 1 — Duplicate Answer Rows (CRITICAL)
`examSolver.ts` route: `upsertAnswer({ id: uuidv4(), ... })` — new UUID each call → onConflictDoUpdate never fires → each answer-change inserts a NEW row → duplicate grading → wrong score.

**Fix:** Use deterministic ID: `id: \`${attemptId}::${questionId}\`` — stable per question, conflict fires correctly on re-answer.

**Why not a unique constraint:** Adding a DB constraint would require a migration. Deterministic ID is schema-free and immediate.

## Bug 2 — JSON Truncation in curriculumGrader (CRITICAL)
`curriculumGrader.ts`: `MAX_TOKENS = 512` — Arabic feedback text was being cut mid-string → `SyntaxError: Unterminated string in JSON at position 39` → all open-ended questions marked wrong.

**Fix:** MAX_TOKENS 512 → 2048. Added regex fallback parser to extract `isCorrect` + `feedback` from partially-valid responses.

## Bug 3 — MCQ Answer Comparison Mismatch
`deterministicGrader.ts`: simple `normalised === normalised` failed when correctAnswer stored as bare key "أ" but student selected full option "أ) الخلية النباتية".

**Fix:** `extractOptionKey()` parses leading key char + separator; `matchMCQ()` handles 4 cases: exact match, both keyed (compare keys), correct is bare key, student is bare key.

## Bug 4 — options format in examContextBuilder (MINOR)
`examContextBuilder.ts` used `Object.entries(q.options)` assuming Record format, but questionExtractor stores options as `string[]`. Now: Array.isArray check first, Record fallback second.
