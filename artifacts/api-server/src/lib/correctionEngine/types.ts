/**
 * correctionEngine/types.ts
 *
 * Shared types for the Curriculum Authority Correction Engine.
 * These types flow through all layers of the engine and are
 * intentionally kept separate so each layer remains independently testable.
 */

// ─── Evidence ─────────────────────────────────────────────────────────────────

/** A single piece of retrieved curriculum content used during correction. */
export interface EvidenceChunk {
  id:        string;
  docId:     string;
  chapter:   string;
  pageRange: string;
  content:   string;
}

/**
 * The internal Evidence Object generated for every corrected question.
 * This object is INTERNAL to the engine.
 * Consumers: Performance Analysis, Weakness Analysis, Future AI Teacher.
 */
export interface CurriculumEvidence {
  chunks:              EvidenceChunk[];
  /** Normalised confidence 0–1 based on number of retrieved chunks vs topK. */
  confidence:          number;
  /** Which resolution strategy was used (for diagnostics). */
  strategy:            'temporary_by_subject' | 'linked_document';
  /** Total chunks searched before filtering. */
  totalChunksSearched: number;
}

/** Status of curriculum evidence retrieval for a question. */
export type EvidenceStatus =
  | 'FOUND'                         // evidence retrieved, AI evaluated
  | 'INSUFFICIENT_CURRICULUM_EVIDENCE' // not enough evidence — no AI call
  | 'SKIPPED';                      // deterministic — no evidence needed

// ─── Correction input ─────────────────────────────────────────────────────────

/** Everything the engine needs to correct one student answer. */
export interface QuestionCorrectionInput {
  questionId:    string;
  question:      string;
  questionType:  string;
  correctAnswer: string | null;
  options:       unknown | null;
  topic:         string | null;
  chapter:       string | null;
  subject:       string;
  grade:         string;
  country:       string;
  studentAnswer: string | null;
}

// ─── Correction result ────────────────────────────────────────────────────────

/**
 * Full result of correcting one question.
 * The `evidence` and `evidenceStatus` fields are internal and not persisted
 * to the database in Phase 1 — they improve aiFeedback quality.
 */
export interface CorrectionResult {
  isCorrect:      boolean;
  /** Maps to the existing gradingMethod column. */
  gradingMethod:  'exact' | 'ai' | 'skipped';
  /** Stored in aiFeedback column. Curriculum-grounded when AI is used. */
  aiFeedback:     string | null;
  /** Internal status — used for logging and future persistence. */
  evidenceStatus: EvidenceStatus;
  /** Internal evidence object — null for deterministic questions. */
  evidence:       CurriculumEvidence | null;
}
