/**
 * cacheService.ts
 *
 * Typed cache layer on top of redisService.
 *
 * Features:
 *   - Deterministic key generation (SHA-256 hash of variable parts)
 *   - Typed get/set with JSON (de)serialization
 *   - Hit/miss/error/saved-Gemini-call metrics (in-process counters)
 *   - TTL constants per data type
 *   - Pattern-based invalidation
 */

import crypto from 'node:crypto';
import { cacheGet, cacheSet, cacheDel, cacheFlushAll, cacheDelByPattern, getRedisInfo } from './redisService';
import { logger } from '../lib/logger';

// ─── TTL constants (seconds) ──────────────────────────────────────────────────

export const TTL = {
  CHAT:      24 * 60 * 60,  // 24 hours
  SEARCH:    24 * 60 * 60,  // 24 hours
  DASHBOARD:  1 * 60 * 60,  //  1 hour
  ANALYTICS:  1 * 60 * 60,  //  1 hour
} as const;

// ─── Metrics ──────────────────────────────────────────────────────────────────

interface Metrics {
  hits:              number;
  misses:            number;
  errors:            number;
  savedGeminiCalls:  number;
  setOperations:     number;
  invalidations:     number;
}

const metrics: Metrics = {
  hits: 0, misses: 0, errors: 0,
  savedGeminiCalls: 0, setOperations: 0, invalidations: 0,
};

export function getMetrics(): Readonly<Metrics> { return { ...metrics }; }

// ─── Key generation ───────────────────────────────────────────────────────────

/** SHA-256 first 16 chars — safe, deterministic, short enough for keys. */
export function hashPart(data: unknown): string {
  return crypto
    .createHash('sha256')
    .update(typeof data === 'string' ? data : JSON.stringify(data))
    .digest('hex')
    .slice(0, 16);
}

export function chatKey(bodyHash: string): string {
  return `sage:chat:${bodyHash}`;
}

export function searchKey(uid: string, country: string, grade: string, subject: string, queryHash: string): string {
  return `sage:search:${uid}:${country}:${grade}:${subject}:${queryHash}`;
}

export function weaknessListKey(uid: string): string {
  return `sage:weakness:${uid}:list`;
}

export function weaknessTopicsKey(uid: string, country: string, grade: string): string {
  return `sage:weakness:${uid}:topics:${country}:${grade}`;
}

export function dashboardKey(uid: string): string {
  return `sage:dashboard:${uid}`;
}

export function analyticsKey(uid: string): string {
  return `sage:analytics:${uid}`;
}

// ─── Core get/set/del ─────────────────────────────────────────────────────────

/**
 * Returns parsed value or null on miss/error.
 * @param isGemini - increments savedGeminiCalls counter on HIT when true.
 */
export async function get<T>(key: string, isGemini = false): Promise<T | null> {
  const t0 = Date.now();
  try {
    const raw = await cacheGet(key);
    const latencyMs = Date.now() - t0;

    if (raw === null) {
      metrics.misses++;
      logger.debug({ key, latencyMs }, 'cache MISS');
      return null;
    }

    metrics.hits++;
    if (isGemini) metrics.savedGeminiCalls++;
    logger.debug({ key, latencyMs }, 'cache HIT');
    return JSON.parse(raw) as T;
  } catch (err) {
    metrics.errors++;
    logger.warn({ err, key }, 'cache: get error — treating as miss');
    return null;
  }
}

/** Store value with given TTL. Fire-and-forget safe (caller can ignore returned promise). */
export async function set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
  try {
    await cacheSet(key, JSON.stringify(value), ttlSeconds);
    metrics.setOperations++;
  } catch (err) {
    metrics.errors++;
    logger.warn({ err, key }, 'cache: set error — skipped');
  }
}

export async function del(key: string): Promise<void> {
  try {
    await cacheDel(key);
    metrics.invalidations++;
  } catch (err) {
    logger.warn({ err, key }, 'cache: del error — skipped');
  }
}

export async function flushAll(): Promise<number> {
  try {
    const n = await cacheFlushAll();
    metrics.invalidations += n;
    return n;
  } catch {
    return 0;
  }
}

/** Invalidate all keys whose raw key string contains `pattern`. */
export async function invalidatePattern(pattern: string): Promise<void> {
  try {
    await cacheDelByPattern(pattern);
    metrics.invalidations++;
    logger.debug({ pattern }, 'cache: pattern invalidation');
  } catch (err) {
    logger.warn({ err, pattern }, 'cache: pattern invalidation error — skipped');
  }
}

// ─── Feature 1: Targeted cache invalidation ───────────────────────────────────
//
// Invalidates ALL cached search results for a given (country, grade, subject).
// Pattern targets: sage:search:{any_uid}:{country}:{grade}:{subject}:{any_hash}
// Does NOT touch unrelated chat, weakness, or other cache entries.

export async function invalidateSubjectSearch(
  country: string,
  grade: string,
  subject: string
): Promise<void> {
  // Substring `:country:grade:subject:` is unique within search keys only.
  const pattern = `:${country}:${grade}:${subject}:`;
  try {
    await cacheDelByPattern(pattern);
    metrics.invalidations++;
    logger.info(
      { country, grade, subject, pattern },
      'cache: invalidated search cache for subject'
    );
  } catch (err) {
    logger.warn({ err, country, grade, subject }, 'cache: subject invalidation error — skipped');
  }
}

// ─── Feature 2: Cache Stampede Protection (Single-Flight) ────────────────────
//
// In-process registry of in-flight compute promises.
// If 100 concurrent requests miss the cache for the same key,
// only ONE compute() runs. All others await the SAME promise.
//
// Node.js single-thread guarantee: between `inFlight.has()` and `inFlight.set()`
// no other code runs (no await between them), so the check-then-set is atomic.

const inFlight = new Map<string, Promise<unknown>>();

export interface OrComputeResult<T> {
  value: T;
  fromCache: boolean;  // true = served from cache or single-flight wait
}

/**
 * Cache-aside with single-flight protection.
 *
 * 1. Cache HIT  → return immediately.
 * 2. In-flight  → wait for the running compute, return its result (no duplicate compute).
 * 3. Cache MISS → run compute(), store in cache, return result.
 *
 * Errors from compute() are re-thrown and do NOT poison the cache.
 */
export async function getOrCompute<T>(
  key: string,
  compute: () => Promise<T>,
  ttlSeconds: number,
  isGemini = false
): Promise<OrComputeResult<T>> {
  // ── 1. Cache lookup ─────────────────────────────────────────────────────────
  const cached = await get<T>(key, isGemini);
  if (cached !== null) return { value: cached, fromCache: true };

  // ── 2. Check in-flight (synchronous — no await between has() and set()) ────
  const existing = inFlight.get(key) as Promise<T> | undefined;
  if (existing) {
    metrics.hits++;
    if (isGemini) metrics.savedGeminiCalls++;
    logger.debug({ key }, 'cache: single-flight wait');
    const value = await existing;
    return { value, fromCache: true };
  }

  // ── 3. Start compute + register flight ──────────────────────────────────────
  const promise = (async (): Promise<T> => {
    try {
      const result = await compute();
      // Only cache successful results — errors are NOT cached
      await set(key, result, ttlSeconds);
      return result;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, promise);    // ← atomic with the has() check above (no await between)
  const value = await promise;
  return { value, fromCache: false };
}

// ─── Health snapshot ──────────────────────────────────────────────────────────

export async function getCacheHealth() {
  const info  = await getRedisInfo();
  const m     = getMetrics();
  return {
    ...info,
    metrics: m,
    inFlightKeys: inFlight.size,
  };
}
