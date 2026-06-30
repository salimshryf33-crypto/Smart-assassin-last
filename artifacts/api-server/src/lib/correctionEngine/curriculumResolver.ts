/**
 * correctionEngine/curriculumResolver.ts
 *
 * ABSTRACTION LAYER — the single integration point between the Correction
 * Engine and the curriculum index.
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │  Future architecture (Phase 2 — Curriculum Linking)             │
 * │                                                                 │
 * │  Exam ──► Linked Curriculum ──► CorrectionEngine               │
 * │                    ▲                                            │
 * │                    │                                            │
 * │           LinkedCurriculumResolver  (Phase 2)                   │
 * │           TemporaryCurriculumResolver (Phase 1, current)        │
 * │                                                                 │
 * │  The CorrectionEngine NEVER needs to change.                    │
 * │  Only the Resolver implementation is swapped.                   │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * Phase 1 implementation: TemporaryCurriculumResolver
 *   → resolves by (country + grade + subject) across all available curriculum
 *
 * Phase 2 implementation: LinkedCurriculumResolver (NOT YET BUILT)
 *   → resolves to a single specific curriculumDocId
 *   → plug in by adding a `linked_curriculum_doc_id` column to exam_records
 *   → implement LinkedCurriculumResolver and update createCurriculumResolver()
 */

// ─── Resolved curriculum descriptor ──────────────────────────────────────────

/**
 * The output of a resolver: tells EvidenceRetriever exactly where to search.
 * In Phase 2, `docId` will be set to the linked document's ID.
 */
export interface ResolvedCurriculum {
  strategy: 'temporary_by_subject' | 'linked_document';
  filters: {
    country: string;
    grade:   string;
    subject: string;
    /** Phase 2: set to the linked curriculumDocId to restrict search scope. */
    docId?:  string;
  };
}

// ─── Resolver interface ───────────────────────────────────────────────────────

/** Input provided by the Correction Engine to every resolver. */
export interface ExamContext {
  country:         string;
  grade:           string;
  subject:         string;
  /**
   * Phase 1: the curriculumDocId is the same as examId (used for tracking only).
   * Phase 2: this will be the linked curriculum document's ID.
   */
  curriculumDocId: string;
}

/**
 * The only contract the Correction Engine has with the curriculum index.
 * Implement this interface to change resolution strategy without touching
 * any other part of the engine.
 */
export interface ICurriculumResolver {
  resolve(context: ExamContext): Promise<ResolvedCurriculum>;
}

// ─── Phase 1: Temporary resolver ─────────────────────────────────────────────

/**
 * Phase 1 implementation.
 *
 * Resolves by (country + grade + subject) — searches ALL curriculum documents
 * matching those attributes. This is intentionally "wide" to maximise evidence
 * recall while there is no explicit curriculum-to-exam link.
 *
 * When Phase 2 ships, this class is NOT deleted — it remains as the fallback
 * when no specific curriculum document is linked to an exam.
 */
export class TemporaryCurriculumResolver implements ICurriculumResolver {
  async resolve(context: ExamContext): Promise<ResolvedCurriculum> {
    return {
      strategy: 'temporary_by_subject',
      filters: {
        country: context.country,
        grade:   context.grade,
        subject: context.subject,
        // docId intentionally omitted — search ALL matching docs
      },
    };
  }
}

// ─── Phase 2 stub (NOT implemented — documents the plug-in point) ─────────────

/**
 * Phase 2 implementation — NOT YET BUILT.
 *
 * When exam_records gains a `linked_curriculum_doc_id` column:
 *
 *   1. Add the column to lib/db/src/schema/exam_records.ts (nullable text)
 *   2. Implement this class:
 *
 *     class LinkedCurriculumResolver implements ICurriculumResolver {
 *       async resolve(context: ExamContext): Promise<ResolvedCurriculum> {
 *         return {
 *           strategy: 'linked_document',
 *           filters: {
 *             country: context.country,
 *             grade:   context.grade,
 *             subject: context.subject,
 *             docId:   context.curriculumDocId,  // restricts search to one doc
 *           },
 *         };
 *       }
 *     }
 *
 *   3. Update createCurriculumResolver() to return LinkedCurriculumResolver.
 *   4. The CorrectionEngine and all other files remain UNCHANGED.
 */

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * The single place where the resolver implementation is chosen.
 *
 * Phase 2 upgrade: replace `return new TemporaryCurriculumResolver()`
 * with `return new LinkedCurriculumResolver()` — nothing else needs to change.
 */
export function createCurriculumResolver(): ICurriculumResolver {
  return new TemporaryCurriculumResolver();
}
