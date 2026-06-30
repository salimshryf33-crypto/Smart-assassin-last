/**
 * correctionEngine/curriculumResolver.ts
 *
 * ABSTRACTION LAYER — the single integration point between the Correction
 * Engine and the curriculum index.
 *
 * Phase 1: TemporaryCurriculumResolver — searches all docs for country+grade+subject
 * Phase 2: LinkedCurriculumResolver    — restricts to the approved linked document
 *           (NOW IMPLEMENTED — driven by exam_records.linked_curriculum_doc_id)
 *
 * The CorrectionEngine NEVER needs to change.
 * createCurriculumResolver() is the only place to swap implementations.
 */

// ─── Resolved curriculum descriptor ──────────────────────────────────────────

export interface ResolvedCurriculum {
  strategy: 'temporary_by_subject' | 'linked_document';
  filters: {
    country: string;
    grade:   string;
    subject: string;
    /** Set in Phase 2 to restrict RAG search to one specific document. */
    docId?:  string;
  };
}

// ─── Resolver interface ───────────────────────────────────────────────────────

export interface ExamContext {
  country:                string;
  grade:                  string;
  subject:                string;
  curriculumDocId:        string;
  /**
   * Phase 2: populated from exam_records.linked_curriculum_doc_id after
   * the Curriculum Linking System approves a match.
   * Null = not yet linked → LinkedCurriculumResolver falls back to subject-wide search.
   */
  linkedCurriculumDocId?: string | null;
}

export interface ICurriculumResolver {
  resolve(context: ExamContext): Promise<ResolvedCurriculum>;
}

// ─── Phase 1: Temporary resolver ─────────────────────────────────────────────

/**
 * Phase 1 fallback.
 * Searches ALL curriculum documents matching country + grade + subject.
 * Used whenever no approved link exists for an exam.
 */
class TemporaryCurriculumResolver implements ICurriculumResolver {
  async resolve(context: ExamContext): Promise<ResolvedCurriculum> {
    return {
      strategy: 'temporary_by_subject',
      filters: {
        country: context.country,
        grade:   context.grade,
        subject: context.subject,
      },
    };
  }
}

// ─── Phase 2: Linked resolver (NOW ACTIVE) ────────────────────────────────────

/**
 * Phase 2 implementation — ACTIVE.
 *
 * Reads exam_records.linked_curriculum_doc_id (written by curriculumLinker.ts
 * on admin approval).  When set, restricts RAG evidence retrieval to that
 * single document — preventing cross-curriculum evidence contamination.
 *
 * Falls back to TemporaryCurriculumResolver when no link is approved yet,
 * ensuring zero regression for all existing exams.
 */
class LinkedCurriculumResolver implements ICurriculumResolver {
  private readonly fallback = new TemporaryCurriculumResolver();

  async resolve(context: ExamContext): Promise<ResolvedCurriculum> {
    const docId = context.linkedCurriculumDocId;

    if (docId && docId.trim().length > 0) {
      return {
        strategy: 'linked_document',
        filters: {
          country: context.country,
          grade:   context.grade,
          subject: context.subject,
          docId,
        },
      };
    }

    // No approved link yet — fall back to subject-wide search
    return this.fallback.resolve(context);
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Returns the active resolver.
 * Phase 2 is now live: LinkedCurriculumResolver is used everywhere.
 * TemporaryCurriculumResolver is its internal fallback for unlinked exams.
 */
export function createCurriculumResolver(): ICurriculumResolver {
  return new LinkedCurriculumResolver();
}
