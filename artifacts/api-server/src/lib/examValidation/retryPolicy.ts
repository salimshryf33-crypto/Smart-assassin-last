/**
 * examValidation/retryPolicy.ts
 *
 * Exponential retry schedule for LOW_EVIDENCE questions.
 *
 * Attempt → next wait before retry:
 *   1st attempt fails  → retry after  10 minutes
 *   2nd attempt fails  → retry after   1 hour
 *   3rd attempt fails  → retry after  24 hours
 *   4th attempt fails  → PERMANENT_LOW_EVIDENCE  (no more retries)
 *
 * Pure functions — no I/O, no side effects, no imports.
 */

/** After this many failed attempts the question is permanently abandoned. */
export const MAX_VALIDATION_ATTEMPTS = 4;

/**
 * Retry delays indexed by the attempt_count value that was just written.
 * RETRY_DELAYS_MS[0]  → delay after attempt_count becomes 1
 * RETRY_DELAYS_MS[1]  → delay after attempt_count becomes 2
 * RETRY_DELAYS_MS[2]  → delay after attempt_count becomes 3
 * (attempt_count = 4 triggers shouldGiveUp before this is consulted)
 */
const RETRY_DELAYS_MS: readonly number[] = [
  10 * 60 * 1_000,          // 10 minutes
  60 * 60 * 1_000,          // 1 hour
  24 * 60 * 60 * 1_000,     // 24 hours
];

/**
 * Returns true when no further automatic retries should be scheduled.
 *
 * Call AFTER incrementing attempt_count:
 *   shouldGiveUp(4) → true  → set PERMANENT_LOW_EVIDENCE
 *   shouldGiveUp(3) → false → schedule 24h retry
 */
export function shouldGiveUp(attemptCount: number): boolean {
  return attemptCount >= MAX_VALIDATION_ATTEMPTS;
}

/**
 * Compute when to retry a LOW_EVIDENCE question.
 * Returns null when the question has exhausted all retries (shouldGiveUp).
 *
 * Call AFTER incrementing attempt_count.
 * Returns a concrete Date, not a duration, so it can be written directly to
 * next_retry_at and compared with <= now() in SQL.
 */
export function computeNextRetryAt(attemptCount: number): Date | null {
  if (shouldGiveUp(attemptCount)) return null;
  // Use the last defined delay when attemptCount exceeds the table length
  const delayMs =
    RETRY_DELAYS_MS[attemptCount - 1] ??
    RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]!;
  return new Date(Date.now() + delayMs);
}
