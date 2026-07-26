/**
 * gradingGuard.ts
 *
 * Runtime Contract enforcement for the Preparation-First Exam Architecture.
 *
 * Phase 3 guarantee: NO AI/Gemini call is permitted during grading.
 * All AI work happens at preparation time (examValidation/).
 * At grading time only deterministic logic runs — no network, no model.
 *
 * ── How it works ──────────────────────────────────────────────────────────────
 *   1. correctionEngine/index.ts calls enterGradingContext(attemptId) before
 *      the grading loop and exitGradingContext() in a finally block after.
 *   2. Every Gemini/AI entry point calls assertNotInGradingContext(callerName)
 *      as its FIRST statement before any network I/O.
 *   3. If a future developer accidentally re-introduces an AI call into the
 *      grading path, the application throws GradingRuntimeAIViolationError
 *      immediately — loud, clear, and impossible to miss in logs or tests.
 *
 * ── Thread-safety note ────────────────────────────────────────────────────────
 *   This guard uses a module-level flag, which is safe for Node.js's single-
 *   threaded event loop.  Grading is sequential: one attempt at a time, all
 *   answers processed in a for-await loop.  No concurrent grading calls exist.
 *
 * ── What MUST call assertNotInGradingContext ──────────────────────────────────
 *   Every function that can trigger a Gemini API call:
 *     - correctionEngine/curriculumGrader.ts  → callGemini()
 *     - examValidation/canonicalAnswerDeriver.ts → callGemini()
 *     - examValidation/openPreparationDeriver.ts → callGemini()
 *     - questionExtractor.ts                  → callGemini()
 *   When adding a new AI integration, inject assertNotInGradingContext() first.
 */

// ─── Error ────────────────────────────────────────────────────────────────────

export class GradingRuntimeAIViolationError extends Error {
  /** The attemptId being graded when the violation was detected. */
  readonly attemptId: string | null;
  /** Which AI entry point fired (for developer diagnostics). */
  readonly aiCaller: string;

  constructor(caller: string, attemptId: string | null) {
    super(
      `[GRADING RUNTIME VIOLATION] AI/Gemini call attempted during grading.\n` +
      `  Caller:    ${caller}\n` +
      `  AttemptId: ${attemptId ?? 'unknown'}\n\n` +
      `  The Preparation-First contract forbids any AI invocation at grading time.\n` +
      `  All AI work must happen in the preparation pipeline (examValidation/).\n` +
      `  To add AI for a new question type:\n` +
      `    1. Add preparation logic in examValidation/openPreparationDeriver.ts\n` +
      `    2. Store the result in exam_open_preparations\n` +
      `    3. Consume it deterministically in correctionEngine/openGrader.ts\n` +
      `  Never call Gemini from correctionEngine/index.ts or any grading function.`
    );
    this.name       = 'GradingRuntimeAIViolationError';
    this.attemptId  = attemptId;
    this.aiCaller   = caller;
  }
}

// ─── State ────────────────────────────────────────────────────────────────────

let _inGradingContext  = false;
let _currentAttemptId: string | null = null;

// ─── API ──────────────────────────────────────────────────────────────────────

/**
 * Activate the grading context guard.
 *
 * Call at the START of gradeAttemptWithCurriculum, before the grading loop.
 * MUST be paired with exitGradingContext() in a finally block.
 */
export function enterGradingContext(attemptId: string): void {
  _inGradingContext  = true;
  _currentAttemptId  = attemptId;
}

/**
 * Deactivate the grading context guard.
 *
 * Call in the finally block of gradeAttemptWithCurriculum.
 * Clears the flag so preparation-time AI calls work normally after grading.
 */
export function exitGradingContext(): void {
  _inGradingContext  = false;
  _currentAttemptId  = null;
}

/**
 * Assert that no grading context is active.
 *
 * Insert as the FIRST statement of every Gemini/AI entry point.
 * Throws GradingRuntimeAIViolationError immediately if grading is in progress.
 *
 * @param caller - human-readable identifier, e.g. 'curriculumGrader.callGemini'
 */
export function assertNotInGradingContext(caller: string): void {
  if (_inGradingContext) {
    throw new GradingRuntimeAIViolationError(caller, _currentAttemptId);
  }
}

/**
 * Read-only predicate for tests and diagnostics.
 * Do NOT use for control flow in production code — use assertNotInGradingContext.
 */
export function isInGradingContext(): boolean {
  return _inGradingContext;
}
