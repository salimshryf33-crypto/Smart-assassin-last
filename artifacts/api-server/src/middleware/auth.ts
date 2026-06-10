/**
 * Firebase ID-token verification middleware.
 *
 * Verifies RS256 JWTs with Google's public-key endpoint — no firebase-admin
 * package or service-account credentials needed.
 *
 * Admin role resolution order:
 *   1. Firebase custom claim  admin: true  (set via Firebase Console)
 *   2. UID present in ADMIN_UIDS env-var   (comma-separated UIDs)
 */
import type { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import { logger } from '../lib/logger';

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID ?? 'sage-78209';
const ISSUER     = `https://securetoken.google.com/${PROJECT_ID}`;
const CERTS_URL  =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

export const ADMIN_UIDS = new Set(
  (process.env.ADMIN_UIDS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
);

// ─── Public-key cache (respects Google Cache-Control max-age) ─────────────────
let _certs: Record<string, string> = {};
let _certsExp = 0;

async function getPublicKeys(): Promise<Record<string, string>> {
  if (Date.now() < _certsExp) return _certs;
  const res = await fetch(CERTS_URL);
  if (!res.ok) throw new Error(`Failed to fetch Google certs: HTTP ${res.status}`);
  const cc = res.headers.get('cache-control') ?? '';
  const m  = cc.match(/max-age=(\d+)/);
  const maxAge = m ? parseInt(m[1]) * 1000 : 3_600_000;
  _certs    = (await res.json()) as Record<string, string>;
  _certsExp = Date.now() + maxAge;
  return _certs;
}

// ─── Token payload ────────────────────────────────────────────────────────────

export interface FirebaseTokenPayload {
  uid:        string;
  sub:        string;
  email?:     string;
  name?:      string;
  picture?:   string;
  aud:        string;
  iss:        string;
  exp:        number;
  iat:        number;
  auth_time?: number;
  /** Custom claim set via Firebase Console / Admin SDK. */
  admin?:     boolean;
  [key: string]: unknown;
}

// ─── Core verifier ────────────────────────────────────────────────────────────

function b64url(s: string): string {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

export async function verifyFirebaseToken(token: string): Promise<FirebaseTokenPayload> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed JWT');

  const [hdr64, pay64, sig64] = parts;
  const header  = JSON.parse(b64url(hdr64)) as { kid?: string; alg?: string };
  const payload = JSON.parse(b64url(pay64)) as FirebaseTokenPayload;

  if (header.alg !== 'RS256') throw new Error(`Unsupported algorithm: ${header.alg}`);
  if (!header.kid)             throw new Error('JWT header missing kid');

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now)        throw new Error('Token expired');
  if (payload.iat > now + 300)  throw new Error('Token issued in the future');
  if (payload.aud !== PROJECT_ID) throw new Error(`Wrong audience: ${payload.aud}`);
  if (payload.iss !== ISSUER)   throw new Error(`Wrong issuer: ${payload.iss}`);

  // Firebase uses `sub` as UID; normalise to `uid` field
  payload.uid = (payload.uid ?? payload.sub) as string;
  if (!payload.uid) throw new Error('Token missing uid/sub');

  // Verify RS256 signature using Google's public cert
  const certs = await getPublicKeys();
  const cert  = certs[header.kid];
  if (!cert) throw new Error(`Unknown key ID: ${header.kid}`);

  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(`${hdr64}.${pay64}`);
  if (!verifier.verify(cert, Buffer.from(sig64, 'base64url'))) {
    throw new Error('JWT signature invalid');
  }

  return payload;
}

// ─── Role helper ──────────────────────────────────────────────────────────────

export function isAdmin(user: FirebaseTokenPayload): boolean {
  return user.admin === true || ADMIN_UIDS.has(user.uid);
}

// ─── Express global augmentation ─────────────────────────────────────────────

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: FirebaseTokenPayload;
    }
  }
}

// ─── Middleware: requireAuth ──────────────────────────────────────────────────

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required — send Authorization: Bearer <idToken>' });
    return;
  }
  verifyFirebaseToken(auth.slice(7))
    .then((payload) => { req.user = payload; next(); })
    .catch((err: Error) => {
      logger.warn({ msg: err.message }, 'auth: rejected token');
      res.status(401).json({ error: 'Invalid or expired authentication token' });
    });
}

// ─── Middleware: requireAdmin ─────────────────────────────────────────────────

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) { res.status(401).json({ error: 'Authentication required' }); return; }
  if (!isAdmin(req.user)) { res.status(403).json({ error: 'Admin access required' }); return; }
  next();
}
