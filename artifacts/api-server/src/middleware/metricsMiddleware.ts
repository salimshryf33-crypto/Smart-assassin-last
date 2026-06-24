/**
 * metricsMiddleware.ts
 *
 * Thin Express middleware — intercepts every request/response to feed
 * metricsService counters. Zero business logic, never throws.
 *
 * Tracks per-request:
 *  - Total requests + active count
 *  - Gemini calls   (path: /api/gemini/generate)
 *  - Search calls   (path: /api/curriculum/search + query params)
 */

import type { Request, Response, NextFunction } from 'express';
import {
  requestStarted,
  requestFinished,
  recordGeminiCall,
  recordSearch,
} from '../services/metricsService';

export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const startMs = Date.now();
  requestStarted();

  res.on('finish', () => {
    const latencyMs = Date.now() - startMs;
    const status    = res.statusCode;
    requestFinished(status);

    const path = req.path ?? '';

    // ── Gemini call tracking ──────────────────────────────────────────────────
    if (req.method === 'POST' && path.includes('/gemini/generate')) {
      recordGeminiCall({
        success:    status < 400,
        latencyMs,
        quotaError: status === 429,
      });
      return;
    }

    // ── Search call tracking ──────────────────────────────────────────────────
    if (req.method === 'GET' && path.includes('/curriculum/search')) {
      const q = req.query as Record<string, string>;
      const subject = q['subject'] ?? 'unknown';
      const grade   = q['grade']   ?? 'unknown';
      recordSearch({ subject, grade, latencyMs });
    }
  });

  next();
}
