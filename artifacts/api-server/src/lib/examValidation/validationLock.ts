/**
 * examValidation/validationLock.ts
 *
 * Distributed exam-level lock via PostgreSQL session advisory locks.
 *
 * Guarantees:
 *   - Only ONE validation worker processes a given exam at a time.
 *   - Works across multiple server instances sharing the same Neon DB.
 *   - Non-blocking: pg_try_advisory_lock returns false immediately instead of
 *     waiting, so a second worker skips rather than queues.
 *   - Lock releases automatically if the database connection is closed or the
 *     server process dies — no orphan locks.
 *
 * Implementation:
 *   Uses the two-argument form  pg_try_advisory_lock(namespace int4, key int4)
 *   to avoid colliding with any other advisory lock users in the system.
 *   'namespace' is a fixed compile-time constant; 'key' is hashtext(examId).
 *
 *   A dedicated pool client is checked out for the duration of the lock so
 *   the session-level lock is tied to one stable connection.
 */

import { getSharedPool } from '../dbPool';
import { logger }        from '../logger';

/**
 * Arbitrary namespace constant.  Never change after the first deployment —
 * changing it would release all outstanding locks silently.
 */
const LOCK_NAMESPACE = 42_001;

/**
 * Acquire an advisory lock for examId, execute fn(), then release.
 *
 * Returns { acquired: false } immediately if another worker holds the lock.
 * Returns { acquired: true, result } if the lock was obtained and fn ran.
 *
 * The caller must handle errors thrown by fn() — they propagate unchanged.
 */
export async function withExamLock<T>(
  examId: string,
  fn:     () => Promise<T>,
): Promise<{ acquired: boolean; result?: T }> {
  const pool   = getSharedPool();
  const client = await pool.connect();     // dedicated connection for this lock

  try {
    // pg_try_advisory_lock(int4, int4) — both args must be 4-byte integers.
    // hashtext() returns int4; cast LOCK_NAMESPACE explicitly to int4.
    const { rows } = await client.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_lock($1::int, hashtext($2)) AS acquired`,
      [LOCK_NAMESPACE, examId],
    );
    const acquired = rows[0]?.acquired ?? false;

    if (!acquired) {
      logger.debug(
        { examId },
        'validationLock: another worker is already validating this exam — skipping',
      );
      return { acquired: false };
    }

    try {
      const result = await fn();
      return { acquired: true, result };
    } finally {
      // Release on the SAME client the lock was acquired on
      await client.query(
        `SELECT pg_advisory_unlock($1::int, hashtext($2))`,
        [LOCK_NAMESPACE, examId],
      ).catch((err: unknown) =>
        logger.error({ err, examId }, 'validationLock: advisory_unlock failed'),
      );
    }
  } finally {
    client.release();
  }
}
