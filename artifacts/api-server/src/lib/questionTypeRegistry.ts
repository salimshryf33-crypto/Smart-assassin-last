/**
 * questionTypeRegistry.ts
 *
 * SINGLE SOURCE OF TRUTH for all supported question types in Sage.
 *
 * Every question type must be declared here ONCE with its full configuration.
 * All other files (deterministicGrader, questionIntegrityChecker,
 * validationPipeline, etc.) must derive their type sets from this registry —
 * never declare type lists independently.
 *
 * Adding a new type:
 *   1. Add an entry to QUESTION_TYPE_REGISTRY below.
 *   2. No other file needs to change — all derived sets update automatically.
 *
 * Invariants enforced by questionTypeRegistry.test.ts (build-time check):
 *   - Every deterministic type is a known type.
 *   - Every option-required type is a known type.
 *   - Every canonical-answer-required type is a known type.
 *   - requiresPreparation=true implies requiresCanonicalAnswer=true.
 *   - No type appears more than once.
 */

// ─── Type definition ──────────────────────────────────────────────────────────

export interface QuestionTypeConfig {
  /** DB value stored in exam_questions.question_type */
  type: string;
  /** Whether this type is recognised and accepted by the integrity checker. */
  known: boolean;
  /**
   * 'deterministic' — graded by exact-match logic, no Gemini.
   * 'ai'            — graded by the CurriculumGrader (Gemini semantic analysis).
   *
   * Note: open-ended types (short_answer, calculation, essay) use gradingStrategy
   * 'ai' here but are graded deterministically at runtime via the stored open
   * preparation package (openGrader.ts).  'ai' signals that Gemini is involved
   * in their PREPARATION, not their grading path.
   */
  gradingStrategy: 'deterministic' | 'ai';
  /**
   * Whether a READY canonical answer must exist in exam_canonical_answers
   * before this question can be graded.  True only for deterministic types
   * (mcq, true_false, fill_in_blank).
   */
  requiresCanonicalAnswer: boolean;
  /**
   * Whether this type uses the open preparation store (exam_open_preparations)
   * instead of exam_canonical_answers.  True for short_answer, calculation, essay.
   * When true: requiresCanonicalAnswer must be false.
   */
  requiresOpenPreparation: boolean;
  /**
   * Whether a preparation job must complete before grading is allowed.
   * Invariant: requiresPreparation=true implies
   *   (requiresCanonicalAnswer=true OR requiresOpenPreparation=true).
   */
  requiresPreparation: boolean;
  /**
   * Whether the integrity checker requires a non-empty options[] array.
   * (MCQ and true_false need options; fill_in_blank does not.)
   */
  requiresOptions: boolean;
}

// ─── Registry ─────────────────────────────────────────────────────────────────

export const QUESTION_TYPE_REGISTRY: readonly QuestionTypeConfig[] = [
  // ── Deterministic types (canonical answer from exam_canonical_answers) ──────
  {
    type:                    'mcq',
    known:                   true,
    gradingStrategy:         'deterministic',
    requiresCanonicalAnswer: true,
    requiresOpenPreparation: false,
    requiresPreparation:     true,
    requiresOptions:         true,
  },
  {
    type:                    'true_false',
    known:                   true,
    gradingStrategy:         'deterministic',
    requiresCanonicalAnswer: true,
    requiresOpenPreparation: false,
    requiresPreparation:     true,
    requiresOptions:         true,
  },
  {
    // fill_in_blank: deterministic (exact-match normalised string equality).
    // Canonical answer required — without a stored correct_answer the grader
    // cannot evaluate the student's free-text response.
    // No options array is needed (unlike MCQ / true_false).
    type:                    'fill_in_blank',
    known:                   true,
    gradingStrategy:         'deterministic',
    requiresCanonicalAnswer: true,
    requiresOpenPreparation: false,
    requiresPreparation:     true,
    requiresOptions:         false,
  },
  // ── Open-prepared types (preparation package from exam_open_preparations) ───
  // Gemini runs ONCE at preparation time to produce a structured package.
  // At grading time openGrader.ts uses the stored package deterministically —
  // zero Gemini calls.  gradingStrategy='ai' signals Gemini involvement in
  // preparation (not in grading).
  {
    type:                    'short_answer',
    known:                   true,
    gradingStrategy:         'ai',
    requiresCanonicalAnswer: false,
    requiresOpenPreparation: true,
    requiresPreparation:     true,
    requiresOptions:         false,
  },
  {
    type:                    'essay',
    known:                   true,
    gradingStrategy:         'ai',
    requiresCanonicalAnswer: false,
    requiresOpenPreparation: true,
    requiresPreparation:     true,
    requiresOptions:         false,
  },
  {
    type:                    'calculation',
    known:                   true,
    gradingStrategy:         'ai',
    requiresCanonicalAnswer: false,
    requiresOpenPreparation: true,
    requiresPreparation:     true,
    requiresOptions:         false,
  },
] as const;

// ─── Derived sets (computed once at module load) ───────────────────────────────

/** All type strings accepted by the integrity checker. */
export const KNOWN_TYPES = new Set<string>(
  QUESTION_TYPE_REGISTRY.filter((t) => t.known).map((t) => t.type),
);

/** Types graded by exact-match logic (no Gemini). */
export const DETERMINISTIC_TYPES = new Set<string>(
  QUESTION_TYPE_REGISTRY
    .filter((t) => t.gradingStrategy === 'deterministic')
    .map((t) => t.type),
);

/** Types that require a non-empty options[] array for structural integrity. */
export const OPTION_REQUIRED_TYPES = new Set<string>(
  QUESTION_TYPE_REGISTRY.filter((t) => t.requiresOptions).map((t) => t.type),
);

/**
 * Types that require a READY canonical answer in exam_canonical_answers
 * before the grading engine may evaluate a student's response.
 */
export const CANONICAL_ANSWER_REQUIRED_TYPES = new Set<string>(
  QUESTION_TYPE_REGISTRY
    .filter((t) => t.requiresCanonicalAnswer)
    .map((t) => t.type),
);

/** Types that require a preparation job to complete before grading. */
export const PREPARATION_REQUIRED_TYPES = new Set<string>(
  QUESTION_TYPE_REGISTRY
    .filter((t) => t.requiresPreparation)
    .map((t) => t.type),
);

/**
 * Types whose preparation package is stored in exam_open_preparations
 * (short_answer, calculation, essay).  Graded at grading time via openGrader.ts
 * using the stored package — no Gemini at grading time.
 */
export const OPEN_PREPARATION_TYPES = new Set<string>(
  QUESTION_TYPE_REGISTRY
    .filter((t) => t.requiresOpenPreparation)
    .map((t) => t.type),
);

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Look up the full config for a question type. Returns undefined if unknown. */
export function getTypeConfig(type: string): QuestionTypeConfig | undefined {
  return QUESTION_TYPE_REGISTRY.find((t) => t.type === type);
}
