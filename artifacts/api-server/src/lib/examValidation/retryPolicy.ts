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

/**
 * Provider/transport failures that can plausibly succeed without changing the
 * question or curriculum. Other HTTP 4xx/configuration failures are terminal;
 * retrying those would spend calls without changing the outcome.
 */
export function isRetryableInferenceFailure(error: unknown): boolean {
  const chain = errorChain(error);
  for (const item of chain) {
    const candidate = item as {
      status?: unknown;
      statusCode?: unknown;
      code?: unknown;
      name?: unknown;
      message?: unknown;
    };
    const message = typeof candidate.message === 'string' ? candidate.message : '';
    const statusValue = Number(candidate.status ?? candidate.statusCode);
    const messageStatus = message.match(/Gemini(?: error)?\s+(\d{3})/i);
    const status = Number.isInteger(statusValue) && statusValue > 0
      ? statusValue
      : messageStatus ? Number(messageStatus[1]) : null;

    if (status !== null) {
      return status === 408 || status === 425 || status === 429 || status >= 500;
    }

    const code = typeof candidate.code === 'string' ? candidate.code.toUpperCase() : '';
    if ([
      'ECONNRESET',
      'ETIMEDOUT',
      'EAI_AGAIN',
      'ECONNREFUSED',
      'ENETUNREACH',
      'EHOSTUNREACH',
      'EPIPE',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_SOCKET',
    ].includes(code)) {
      return true;
    }

    if (
      candidate.name === 'AbortError' ||
      candidate.name === 'SyntaxError' ||
      /fetch failed|network error|gemini returned empty response/i.test(message)
    ) {
      return true;
    }
  }
  return false;
}

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current = error;
  for (let depth = 0; current && depth < 5; depth++) {
    chain.push(current);
    const cause = (current as { cause?: unknown }).cause;
    if (!cause || cause === current) break;
    current = cause;
  }
  return chain;
}
