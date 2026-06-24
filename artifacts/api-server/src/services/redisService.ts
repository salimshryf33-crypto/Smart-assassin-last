/**
 * redisService.ts
 *
 * Redis connection layer with automatic in-memory fallback.
 *
 * - If REDIS_URL is set → tries to connect to real Redis (ioredis).
 * - If REDIS_URL is not set, or Redis crashes/times out → falls back to
 *   an in-process TTL Map.  Application never sees an error.
 *
 * Exposed API is identical regardless of backend:
 *   get(key)            → string | null
 *   set(key, val, ttl)  → void
 *   del(key)            → void
 *   flushAll()          → number (keys deleted)
 *   getInfo()           → RedisInfo
 */

import Redis from 'ioredis';
import { logger } from '../lib/logger';

// ─── In-memory fallback ───────────────────────────────────────────────────────

interface MemEntry { value: string; expiresAt: number; }

class MemoryBackend {
  private store = new Map<string, MemEntry>();
  private readonly MAX_KEYS = 2_000;

  get(key: string): string | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) { this.store.delete(key); return null; }
    return entry.value;
  }

  set(key: string, value: string, ttlSeconds: number): void {
    if (this.store.size >= this.MAX_KEYS) {
      // Evict oldest entry (first inserted key in Map iteration order)
      const oldest = this.store.keys().next().value;
      if (oldest) this.store.delete(oldest);
    }
    this.store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1_000 });
  }

  del(key: string): void { this.store.delete(key); }

  flushAll(): number {
    const n = this.store.size;
    this.store.clear();
    return n;
  }

  keyCount(): number { return this.store.size; }

  /** Remove all keys whose raw key string includes the given substring. */
  delByPattern(pattern: string): number {
    let deleted = 0;
    for (const key of this.store.keys()) {
      if (key.includes(pattern)) { this.store.delete(key); deleted++; }
    }
    return deleted;
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RedisInfo {
  backend: 'redis' | 'memory';
  connected: boolean;
  keyCount: number | null;
  uptime: number;
  startedAt: string;
}

// ─── Service ──────────────────────────────────────────────────────────────────

const memory   = new MemoryBackend();
const startedAt = new Date();
let redisClient: Redis | null = null;
let usingRedis  = false;

function initRedis(): void {
  const url = process.env['REDIS_URL'];
  if (!url) {
    logger.info('redisService: no REDIS_URL — using in-memory cache');
    return;
  }

  try {
    const client = new Redis(url, {
      maxRetriesPerRequest:   3,
      connectTimeout:         3_000,
      commandTimeout:         2_000,
      enableOfflineQueue:     false,
      lazyConnect:            true,
      retryStrategy: (times) => {
        if (times > 5) { return null; } // stop retrying — fall back to memory
        return Math.min(times * 500, 3_000);
      },
    });

    client.on('connect',     () => { usingRedis = true;  logger.info('redisService: Redis connected'); });
    client.on('ready',       () => { usingRedis = true;  });
    client.on('error',  (err) => { usingRedis = false; logger.warn({ err }, 'redisService: Redis error — using memory fallback'); });
    client.on('close',       () => { usingRedis = false; logger.warn('redisService: Redis connection closed'); });
    client.on('reconnecting',() => { logger.info('redisService: reconnecting…'); });

    client.connect().catch(() => {
      usingRedis = false;
      logger.warn('redisService: initial connect failed — using memory fallback');
    });

    redisClient = client;
  } catch (err) {
    logger.warn({ err }, 'redisService: Redis init failed — using memory fallback');
  }
}

initRedis();

// ─── Unified get / set / del ──────────────────────────────────────────────────

export async function cacheGet(key: string): Promise<string | null> {
  if (usingRedis && redisClient) {
    try { return await redisClient.get(key); }
    catch { /* fall through to memory */ }
  }
  return memory.get(key);
}

export async function cacheSet(key: string, value: string, ttlSeconds: number): Promise<void> {
  if (usingRedis && redisClient) {
    try { await redisClient.set(key, value, 'EX', ttlSeconds); return; }
    catch { /* fall through to memory */ }
  }
  memory.set(key, value, ttlSeconds);
}

export async function cacheDel(key: string): Promise<void> {
  if (usingRedis && redisClient) {
    try { await redisClient.del(key); }
    catch { /* ignore */ }
  }
  memory.del(key);
}

export async function cacheFlushAll(): Promise<number> {
  let deleted = 0;
  if (usingRedis && redisClient) {
    try {
      await redisClient.flushall();
      // Count is not critical
    } catch { /* ignore */ }
  }
  deleted += memory.flushAll();
  return deleted;
}

/** Delete all keys whose string contains `pattern` (memory backend + Redis SCAN). */
export async function cacheDelByPattern(pattern: string): Promise<void> {
  memory.delByPattern(pattern);
  if (usingRedis && redisClient) {
    try {
      let cursor = '0';
      do {
        const [next, keys] = await redisClient.scan(cursor, 'MATCH', `*${pattern}*`, 'COUNT', '100');
        cursor = next;
        if (keys.length > 0) await redisClient.del(...keys);
      } while (cursor !== '0');
    } catch { /* ignore */ }
  }
}

export async function getRedisInfo(): Promise<RedisInfo> {
  let keyCount: number | null = null;

  if (usingRedis && redisClient) {
    try { keyCount = await redisClient.dbsize(); } catch { /* ignore */ }
  } else {
    keyCount = memory.keyCount();
  }

  return {
    backend:   usingRedis ? 'redis' : 'memory',
    connected: usingRedis,
    keyCount,
    uptime:    Math.floor((Date.now() - startedAt.getTime()) / 1_000),
    startedAt: startedAt.toISOString(),
  };
}

