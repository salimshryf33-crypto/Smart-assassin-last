/**
 * requestId — Unique request tracing middleware.
 *
 * Attaches a UUID to every request/response for end-to-end traceability.
 * Respects an existing X-Request-ID header if forwarded by a proxy.
 *
 * Usage: register in app.ts before routes and pino-http so the ID
 * appears in every structured log line.
 */
import { type RequestHandler } from 'express';
import { randomUUID } from 'node:crypto';

declare global {
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}

export const requestId: RequestHandler = (req, res, next) => {
  const id = (req.headers['x-request-id'] as string | undefined) ?? randomUUID();
  req.requestId = id;
  res.setHeader('X-Request-ID', id);
  next();
};
