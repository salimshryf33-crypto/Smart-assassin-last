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

// ─── Health snapshot ──────────────────────────────────────────────────────────

export async function getCacheHealth() {
  const info = await getRedisInfo();
  return { ...info, metrics: getMetrics() };
}
