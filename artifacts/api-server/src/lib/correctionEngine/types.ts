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

/** Outcome of Stage 2 evidence validation. */
export interface EvidenceValidation {
  isValid:    boolean;
  /** Machine-readable reason when isValid=false. */
  reason?:    'no_chunks' | 'low_confidence' | 'irrelevant_chunks';
  /** Human-readable Arabic description for feedback. */
  message?:   string;
}

/** Status of curriculum evidence retrieval for a question. */
export type EvidenceStatus =
  | 'FOUND'                            // evidence retrieved, AI evaluated
  | 'INSUFFICIENT_CURRICULUM_EVIDENCE' // not enough evidence — no AI call
  | 'SKIPPED';                         // deterministic — no evidence needed

// ─── Correction Package (Stage 3) ────────────────────────────────────────────

/**
 * The formal Correction Package built by the backend before any Gemini call.
 * This is the ONLY educational input that may reach Gemini.
 *
 * Gemini must never receive permission to search beyond this package.
 */
export interface CorrectionPackage {
  /** The question text exactly as presented to the student. */
  question:             string;
  questionType:         string;
  /** Student's submitted answer (trimmed). */
  studentAnswer:        string;
  /** Model answer from question bank (null if not stored). */
  correctAnswer:        string | null;
  /** Curriculum topic and chapter metadata for context. */
  topic:                string | null;
  chapter:              string | null;
  /** The validated curriculum evidence — the educational authority. */
  evidence:             CurriculumEvidence;
  /** Normalised confidence of the evidence (0–1). */
  curriculumConfidence: number;
  /** Which document the evidence originates from (when linked). */
  linkedDocId:          string | undefined;
}

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
 *
 * scoreRatio (new in Phase 1.5):
 *   0.0        → incorrect / no answer
 *   0.01–0.49  → partial, insufficient for credit
 *   0.5–0.99   → partial credit (essay partially correct)
 *   1.0        → fully correct
 *
 * isCorrect is derived: scoreRatio >= 0.5
 * This preserves backward compatibility with all DB columns and callers.
 */
export interface CorrectionResult {
  isCorrect:      boolean;
  /**
   * Proportional correctness score (0.0–1.0).
   * Used for weighted attempt scorePct.  Not persisted as a separate column —
   * the attempt-level scorePct reflects the weighted average.
   */
  scoreRatio:     number;
  /**
   * Maps to the existing gradingMethod column.
   * 'insufficient' → INSUFFICIENT_CURRICULUM_EVIDENCE, excluded from weakness stats.
   */
  gradingMethod:  'exact' | 'ai' | 'skipped' | 'insufficient';
  /** Stored in aiFeedback column. Curriculum-grounded when AI is used. */
  aiFeedback:     string | null;
  /** Internal status — used for logging and weakness analysis filtering. */
  evidenceStatus: EvidenceStatus;
  /** Internal evidence object — null for deterministic questions. */
  evidence:       CurriculumEvidence | null;
}
