/**
 * rateLimiter — production-grade per-user Token Bucket rate limiting.
 *
 * Uses PostgreSQL for persistence (survives restarts, works across processes).
 * Falls back gracefully if DB is unavailable — never blocks the request on DB error.
 *
 * Usage:
 *   router.post('/upload', requireAuth, rateLimit('pdf_upload'), upload.single('pdf'), handler)
 *
 * Action limits:
 *   pdf_upload       — 10 per hour
 *   exam_extraction  — 5  per hour
 *   ocr_recovery     — 15 per hour
 *   ai_chat          — 60 per hour
 *   exam_generation  — 5  per hour
 *   default          — 120 per hour
 */
import { type RequestHandler } from 'express';
import { getMigrationPool } from '../lib/dbMigrations';
import { logger } from '../lib/logger';

// ─── Bucket configuration ─────────────────────────────────────────────────────

interface BucketConfig {
  capacity:         number;   // max tokens
  refillPerSecond:  number;   // tokens added per second
}

const BUCKET_CONFIGS: Record<string, BucketConfig> = {
  pdf_upload:       { capacity: 10,  refillPerSecond: 10  / 3600 },
  exam_extraction:  { capacity: 5,   refillPerSecond: 5   / 3600 },
  ocr_recovery:     { capacity: 15,  refillPerSecond: 15  / 3600 },
  ai_chat:          { capacity: 60,  refillPerSecond: 60  / 3600 },
  exam_generation:  { capacity: 5,   refillPerSecond: 5   / 3600 },
  default:          { capacity: 120, refillPerSecond: 120 / 3600 },
};

function getConfig(action: string): BucketConfig {
  return BUCKET_CONFIGS[action] ?? BUCKET_CONFIGS['default']!;
}

// ─── Core logic ───────────────────────────────────────────────────────────────

interface BucketResult {
  allowed:       boolean;
  remaining:     number;
  resetAt:       Date;
  retryAfterSec: number;
}

async function consumeToken(uid: string, action: string): Promise<BucketResult> {
  const cfg     = getConfig(action);
  const bucketId = `${uid}:${action}`;
  const db      = getMigrationPool();

  // Atomic upsert + refill + consume in one transaction
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Get or create bucket
    const existing = await client.query<{
      tokens: number;
      last_refill_at: Date;
    }>(
      'SELECT tokens, last_refill_at FROM rate_limit_buckets WHERE id = $1 FOR UPDATE',
      [bucketId]
    );

    const now        = new Date();
    let tokens: number;
    let lastRefillAt: Date;

    if (existing.rows.length === 0) {
      // New bucket — start full (minus 1 for this request)
      tokens       = cfg.capacity - 1;
      lastRefillAt = now;

      await client.query(
        `INSERT INTO rate_limit_buckets (id, tokens, last_refill_at, updated_at)
         VALUES ($1, $2, $3, $3)
         ON CONFLICT (id) DO NOTHING`,
        [bucketId, tokens, now]
      );
    } else {
      const row        = existing.rows[0]!;
      lastRefillAt     = row.last_refill_at;
      const elapsed    = (now.getTime() - lastRefillAt.getTime()) / 1000;
      const refilled   = Math.min(cfg.capacity, row.tokens + elapsed * cfg.refillPerSecond);
      tokens           = refilled - 1;

      await client.query(
        `UPDATE rate_limit_buckets
         SET tokens = $2, last_refill_at = $3, updated_at = $3
         WHERE id = $1`,
        [bucketId, Math.max(tokens, -1), now]
      );
    }

    await client.query('COMMIT');

    const allowed      = tokens >= 0;
    const remaining    = Math.max(0, Math.floor(tokens));
    const refillNeeded = allowed ? 0 : Math.ceil((1 - (tokens + 1)) / cfg.refillPerSecond);
    const resetAt      = new Date(now.getTime() + refillNeeded * 1000);

    return { allowed, remaining, resetAt, retryAfterSec: refillNeeded };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── Middleware factory ───────────────────────────────────────────────────────

/**
 * Returns a rate-limiting middleware for the given action.
 * Must be used AFTER requireAuth so req.user is populated.
 */
export function rateLimit(action: string): RequestHandler {
  return async (req, res, next) => {
    const uid = req.user?.uid;
    if (!uid) {
      // requireAuth should have rejected before we get here, but be safe
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    try {
      const result = await consumeToken(uid, action);

      // Always include rate limit headers
      res.setHeader('X-RateLimit-Action',    action);
      res.setHeader('X-RateLimit-Remaining', result.remaining);
      res.setHeader('X-RateLimit-Reset',     Math.floor(result.resetAt.getTime() / 1000));

      if (!result.allowed) {
        logger.warn(
          { uid, action, retryAfterSec: result.retryAfterSec },
          'rateLimiter: request rejected (429)'
        );

        res.setHeader('Retry-After', result.retryAfterSec);
        res.status(429).json({
          error:            'Too many requests',
          action,
          retryAfterSeconds: result.retryAfterSec,
          resetAt:           result.resetAt.toISOString(),
        });
        return;
      }

      next();
    } catch (err) {
      // Fail open — DB unavailable should not block legitimate users
      logger.error({ err, uid, action }, 'rateLimiter: DB error — failing open');
      next();
    }
  };
}

// ─── Admin helper: reset a user's bucket ─────────────────────────────────────

export async function resetUserBucket(uid: string, action: string): Promise<void> {
  const cfg = getConfig(action);
  const db  = getMigrationPool();
  await db.query(
    `INSERT INTO rate_limit_buckets (id, tokens, last_refill_at, updated_at)
     VALUES ($1, $2, now(), now())
     ON CONFLICT (id) DO UPDATE
       SET tokens = $2, last_refill_at = now(), updated_at = now()`,
    [`${uid}:${action}`, cfg.capacity]
  );
}

// ─── Admin helper: get bucket status for a user ───────────────────────────────

export async function getBucketStatus(uid: string): Promise<Record<string, {
  tokens: number; capacity: number; action: string;
}>> {
  const db = getMigrationPool();
  const res = await db.query<{ id: string; tokens: number }>(
    `SELECT id, tokens FROM rate_limit_buckets WHERE id LIKE $1`,
    [`${uid}:%`]
  );
  const out: Record<string, { tokens: number; capacity: number; action: string }> = {};
  for (const row of res.rows) {
    const action = row.id.slice(uid.length + 1);
    out[action]  = { tokens: Math.max(0, row.tokens), capacity: getConfig(action).capacity, action };
  }
  return out;
}
