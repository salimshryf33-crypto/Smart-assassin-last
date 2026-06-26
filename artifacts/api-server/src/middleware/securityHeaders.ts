/**
 * securityHeaders — Production security headers middleware.
 *
 * Adds defense-in-depth browser security headers to every response.
 * Must be registered BEFORE routes in app.ts.
 *
 * Headers applied:
 *   X-Content-Type-Options   — prevent MIME sniffing
 *   X-Frame-Options          — prevent clickjacking
 *   X-XSS-Protection         — legacy XSS filter (extra layer)
 *   Referrer-Policy          — limit referrer leakage
 *   Permissions-Policy       — disable unused browser features
 *   X-Sage-Version           — platform identifier (non-sensitive)
 *   Removes X-Powered-By     — hide Express fingerprint
 */
import { type RequestHandler } from 'express';

export const securityHeaders: RequestHandler = (_req, res, next) => {
  res.removeHeader('X-Powered-By');
  res.setHeader('X-Content-Type-Options',      'nosniff');
  res.setHeader('X-Frame-Options',              'DENY');
  res.setHeader('X-XSS-Protection',             '1; mode=block');
  res.setHeader('Referrer-Policy',              'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy',           'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('X-Sage-Version',               '2.0');
  // HSTS — force HTTPS for 1 year (production only; ignored over HTTP in dev)
  res.setHeader('Strict-Transport-Security',    'max-age=31536000; includeSubDomains');
  // CSP — API server returns JSON; block framing and restrict sources
  res.setHeader('Content-Security-Policy',      "default-src 'none'; frame-ancestors 'none'");
  next();
};
