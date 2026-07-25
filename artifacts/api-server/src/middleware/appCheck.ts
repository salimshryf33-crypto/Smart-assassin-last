/**
 * Firebase App Check verification middleware.
 *
 * Verifies RS256 JWTs issued by Firebase App Check using Google's JWKS endpoint.
 * By default runs in "log-only" mode (never blocks requests).
 * Set APP_CHECK_ENFORCE=true to hard-reject requests with invalid/missing tokens.
 *
 * Header: X-Firebase-AppCheck: <token>
 */
import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { logger } from '../lib/logger';

const JWKS_URL = 'https://firebaseappcheck.googleapis.com/v1/jwks';
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID ?? 'sage-78209';
const ENFORCE = process.env.APP_CHECK_ENFORCE === 'true';

interface JwkKey {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg: string;
  use: string;
}

let _keys: JwkKey[] = [];
let _keysExp = 0;

async function fetchJwks(): Promise<JwkKey[]> {
  if (Date.now() < _keysExp && _keys.length) return _keys;
  const res = await fetch(JWKS_URL);
  if (!res.ok) throw new Error(`JWKS fetch failed: HTTP ${res.status}`);
  const data = (await res.json()) as { keys: JwkKey[] };
  _keys = data.keys;
  _keysExp = Date.now() + 3_600_000;
  return _keys;
}

function b64(s: string): string {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

export async function verifyAppCheckToken(token: string): Promise<boolean> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const [hdr64, pay64, sig64] = parts;
    const header  = JSON.parse(b64(hdr64)) as { kid?: string; alg?: string };
    const payload = JSON.parse(b64(pay64)) as {
      iss?: string; aud?: string | string[]; exp?: number;
    };
    if (!header.kid || header.alg !== 'RS256') return false;
    const now = Math.floor(Date.now() / 1000);
    if (!payload.exp || payload.exp < now) return false;
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud ?? ''];
    if (!aud.some((a) => a.includes(PROJECT_ID))) return false;
    const keys = await fetchJwks();
    const jwk  = keys.find((k) => k.kid === header.kid);
    if (!jwk) return false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const publicKey = crypto.createPublicKey({ key: jwk as unknown as any, format: 'jwk' });
    const verifier  = crypto.createVerify('RSA-SHA256');
    verifier.update(`${hdr64}.${pay64}`);
    return verifier.verify(publicKey, Buffer.from(sig64, 'base64url'));
  } catch {
    return false;
  }
}

export function appCheckMiddleware(req: Request, res: Response, next: NextFunction): void {
  const token = req.headers['x-firebase-appcheck'] as string | undefined;

  if (!token) {
    if (ENFORCE) {
      res.status(401).json({ error: 'App Check token required' });
      return;
    }
    next();
    return;
  }

  verifyAppCheckToken(token)
    .then((valid) => {
      if (!valid) {
        logger.warn({ url: req.url }, 'appCheck: invalid token rejected');
        if (ENFORCE) {
          res.status(401).json({ error: 'Invalid App Check token' });
          return;
        }
      }
      next();
    })
    .catch((err: Error) => {
      logger.error({ msg: err.message }, 'appCheck: verification error');
      next();
    });
}
