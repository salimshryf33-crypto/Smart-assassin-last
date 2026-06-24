/**
 * cacheMiddleware.ts
 *
 * Transparent cache layer for Express GET routes.
 *
 * Usage:
 *   router.get('/path', requireAuth, cacheMiddleware(keyFn, ttl), handler)
 *
 * Behaviour:
 *   HIT  → responds immediately with cached JSON + X-Cache: HIT header.
 *   MISS → patches res.json() to also store the response, then calls next().
 *
 * Fail-safe: any cache error is swallowed — request always proceeds normally.
 */

import type { Request, Response, NextFunction } from 'express';
import * as cache from '../services/cacheService';
import { logger } from '../lib/logger';

type KeyFn = (req: Request) => string;

export function cacheMiddleware(keyFn: KeyFn, ttlSeconds: number) {
  return async function (req: Request, res: Response, next: NextFunction): Promise<void> {
    const key = keyFn(req);

    // ── Cache lookup ─────────────────────────────────────────────────────────
    try {
      const hit = await cache.get<unknown>(key);
      if (hit !== null) {
        res.setHeader('X-Cache', 'HIT');
        res.json(hit);
        return;
      }
    } catch (err) {
      logger.warn({ err, key }, 'cacheMiddleware: lookup error — proceeding without cache');
    }

    // ── Cache miss: patch res.json to store the response ─────────────────────
    res.setHeader('X-Cache', 'MISS');
    const originalJson = res.json.bind(res) as (body: unknown) => Response;

    res.json = function (body: unknown): Response {
      // Store async — never block the response
      cache.set(key, body, ttlSeconds).catch((err) =>
        logger.warn({ err, key }, 'cacheMiddleware: set error — skipped')
      );
      return originalJson(body);
    };

    next();
  };
}
