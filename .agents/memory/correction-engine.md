---
name: Curriculum Authority Correction Engine
description: Phase 1 — makes exam correction use curriculum RAG evidence instead of Gemini general knowledge. ICurriculumResolver abstraction isolates the engine from Phase 2 changes.
---

## Rule
All open-ended question correction (short_answer, essay, calculation, reasoning, etc.)
MUST go through the Curriculum Authority Correction Engine, not raw Gemini calls.
Gemini receives ONLY the curriculum evidence chunks — never a "use your knowledge" instruction.

**Why:** Pre-engine Gemini hallucinated scientific facts during correction, producing
confident wrong feedback. The engine prevents this by gating AI calls on curriculum evidence.

**How to apply:** The engine lives at `artifacts/api-server/src/lib/correctionEngine/`.
`autoGrader.ts` is now a thin façade — its public interface is identical (gradeAttempt,
gradeAnswer, GradeResult, AttemptGradeResult) and zero callers need to change.

## File map

```
correctionEngine/
  types.ts              — CurriculumEvidence, CorrectionResult, QuestionCorrectionInput
  curriculumResolver.ts — ICurriculumResolver interface + TemporaryCurriculumResolver (Phase 1)
  evidenceRetriever.ts  — RAG retrieval via searchChunks(); per-attempt in-memory cache
  deterministicGrader.ts — MCQ/TF/fill_in_blank — gradeDeterministic() — no Gemini ever
  curriculumGrader.ts   — open-ended — gradeWithCurriculum() — Gemini + evidence only
  index.ts              — gradeAttemptWithCurriculum() orchestrator
autoGrader.ts           — thin façade (public interface unchanged)
```

## Decision tree (per question)

```
questionType in DETERMINISTIC_TYPES? (mcq, true_false, fill_in_blank)
  YES → gradeDeterministic()         no Gemini, no network
  NO  → EvidenceRetriever.retrieve()
           → EvidenceRetriever.isSufficient()?
               YES (confidence ≥ 1/topK AND chunks.length > 0)
                   → gradeWithCurriculum()  Gemini + evidence only, temp 0.05
               NO  → INSUFFICIENT_CURRICULUM_EVIDENCE
                      aiFeedback = "تعذر تصحيح هذه الإجابة لعدم توفر دليل كافٍ من المنهج الدراسي."
                      no Gemini call
```

## Phase 2 upgrade path (Curriculum Linking)

1. Add nullable `linked_curriculum_doc_id` column to `exam_records` table.
2. Implement `LinkedCurriculumResolver implements ICurriculumResolver` that returns
   `{ strategy: 'linked_document', filters: { ..., docId: context.curriculumDocId } }`.
3. Update `createCurriculumResolver()` factory to return `LinkedCurriculumResolver`.
4. `EvidenceRetriever` already handles Phase 2: it filters chunks by `docId` when present.
5. **CorrectionEngine, routes, DB schema — UNCHANGED.**

## DB schema notes

- No new columns added — Phase 1 uses existing `isCorrect`, `gradingMethod`, `aiFeedback`.
- `scorePct` in `exam_attempts` is Drizzle `numeric` → TypeScript `string | null`.
  Pass `String(score)` when calling `examSolverStore.updateAttempt()`.
- Evidence object is internal (not persisted in Phase 1). Future: add `curriculum_evidence`
  JSONB column to `exam_answers` when Future AI Teacher needs it.

## Invariants to never break

- `gradeAttempt()` signature and return type must remain identical (AttemptGradeResult).
- `weaknessAnalyzer.ts` and `examSolverStore.ts` must NOT be modified by the engine.
- Evidence retriever uses `searchChunks()` from `curriculumStorage.ts` — synchronous, in-memory.
- `getEmbedding()` failure in evidenceRetriever is always caught — keyword-only fallback.
- Gemini temperature MUST stay at 0.05 in curriculumGrader — evaluator role, not generator.
