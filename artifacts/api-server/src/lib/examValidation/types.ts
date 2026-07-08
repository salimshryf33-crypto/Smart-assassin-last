/**
 * examValidation/types.ts
 *
 * Shared types for the Exam Validation Pipeline and Canonical Answer Layer.
 * No external dependencies — safe to import from anywhere.
 */

// ─── Validation Status ────────────────────────────────────────────────────────

/**
 * Lifecycle of a single exam question through the validation pipeline.
 *
 *  PENDING                → not yet processed
 *  VALIDATED              → integrity checks passed; evidence retrieved; answer not yet derived
 *  LOW_EVIDENCE           → integrity ok but curriculum evidence insufficient; scheduled for retry
 *  INVALID                → failed structural integrity checks; never retried
 *  READY                  → canonical answer derived with confidence ≥ threshold; correct_answer populated
 *  PERMANENT_LOW_EVIDENCE → exhausted all retry attempts; curriculum does not contain the answer;
 *                           blocks publishing (same as LOW_EVIDENCE) but never retried again
 */
export type ValidationStatus =
  | 'PENDING'
  | 'VALIDATED'
  | 'LOW_EVIDENCE'
  | 'INVALID'
  | 'READY'
  | 'PERMANENT_LOW_EVIDENCE';

// ─── Question integrity ───────────────────────────────────────────────────────

export interface QuestionIntegrityResult {
  passed:  boolean;
  reason?: string;   // human-readable failure reason when passed=false
}

// ─── Evidence retrieval ───────────────────────────────────────────────────────

export interface EvidenceChunk {
  id:        string;
  content:   string;
  chapter:   string;
  pageRange: string;
}

export type RetrievalStatus = 'SUFFICIENT' | 'LOW' | 'NONE';

export interface EvidenceResult {
  topChunks:       EvidenceChunk[];
  chunkIds:        string[];
  pages:           string[];
  retrievalScore:  number;          // 0-1 normalised score (chunk count proxy)
  retrievalStatus: RetrievalStatus;
}

// ─── Answer derivation ────────────────────────────────────────────────────────

export interface DerivationResult {
  correctOption: string;
  confidence:    number;   // 0.0 – 1.0
  reasoning:     string;
}

// ─── Canonical answer record ──────────────────────────────────────────────────

export interface CanonicalAnswer {
  id:               string;
  questionId:       string;
  correctOption:    string | null;
  confidence:       number | null;
  reasoningSummary: string | null;
  evidenceChunkIds: string[];
  evidencePages:    string[];
  validationStatus: ValidationStatus;
  retrievalVersion: number;
  // ── Phase 3: Attempt tracking ─────────────────────────────────────────────
  attemptCount:     number;             // incremented on every non-skip attempt
  lastAttemptAt:    Date | null;        // timestamp of the most recent attempt
  nextRetryAt:      Date | null;        // when to retry; null = done or not yet scheduled
  // ─────────────────────────────────────────────────────────────────────────
  createdAt:        Date;
  updatedAt:        Date;
  verified:         boolean;
}

// ─── Minimal question shape needed by the pipeline ───────────────────────────
// Avoids importing from @workspace/db — the pipeline is self-contained.

export interface PipelineQuestion {
  id:           string;
  examId:       string;
  question:     string;
  questionType: string;
  options:      unknown;          // string[] for MCQ, null for others
  correctAnswer:string | null;
  subject:      string;
  grade:        string;
  country:      string;
  topic:        string | null;
  chapter:      string | null;
}

// ─── Publish readiness ────────────────────────────────────────────────────────

export interface PublishReadinessResult {
  ready:             boolean;
  totalMcq:          number;
  readyCount:        number;
  invalidCount:      number;
  lowEvidenceCount:  number;
  permanentLowCount: number;
  pendingCount:      number;
  blockingQuestions: Array<{ id: string; status: ValidationStatus | 'UNPROCESSED' }>;
}
