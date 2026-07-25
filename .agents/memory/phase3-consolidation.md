---
name: Phase 3 Consolidation
description: TypeScript build fixes and runtime Gemini guarantee enforcement completed in Phase 3.
---

# Phase 3 — Exam System Consolidation

## Rules established

**Runtime Guarantee (enforced):** Gemini is NEVER called at grading time, for any question type, from any code path.
- `correctionEngine/index.ts` — unknown-type else branch now returns `pending_preparation` (no Gemini)
- `autoGrader.ts` — open types now consume open prep package deterministically (no Gemini)
- `curriculumGrader.ts` `gradeWithCurriculum()` still exists but is only imported by preparation-time derivers (canonicalAnswerDeriver, openPreparationDeriver). Keep it there only.

## TypeScript build setup (important)

`lib/db` and `lib/api-zod` are TypeScript project references — they must be built before typechecking api-server:
```bash
npx tsc --build lib/db/tsconfig.json lib/api-zod/tsconfig.json
```
Both have `composite: true, emitDeclarationOnly: true`. Run from workspace root. No npm build scripts in either package.

## Drizzle jsonb typing pattern

Drizzle SELECT returns jsonb columns as `unknown`; INSERT types expect `Json | null | undefined`.
When spreading a SELECT result into `upsertExamRecord`, TypeScript errors.
**Fix applied:** `upsertExamRecord` signature uses `UpsertExamRecordInput = Omit<InsertExamRecord, 'ocrDiagnostics'> & { ocrDiagnostics?: unknown }` — the implementation casts internally.

## Express 5 type patterns

- `req.params['uid']` — type is `string | string[]` in Express 5. Cast: `req.params['uid'] as string`.
- `return res.json(...)` inside async route handler triggers TS7030 with `noImplicitReturns: true`. Pattern: `res.json(...); return;` (separate statements).
- `Parameters<typeof Storage>` fails — use `ConstructorParameters<typeof Storage>` for GCS client config.

## Open issues (proposed as tasks #4, #5, #6)

- `curriculumGrader.ts` needs deprecation guard (task #4)
- `auditLog.ts` vs `observability/auditLogger.ts` split trail (task #5)
- Grading engine has no regression tests (task #6)
