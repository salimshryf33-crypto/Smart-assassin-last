/**
 * Firebase Admin SDK — lazy initializer.
 *
 * Used exclusively for writing Custom Claims.
 * Token verification continues to use the manual RS256 verifier in auth.ts.
 * Requires FIREBASE_SERVICE_ACCOUNT env var (full service-account JSON).
 */

import { initializeApp, getApps, cert, type App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { logger } from './logger';

let _app: App | null = null;

function getAdminApp(): App {
  if (_app) return _app;

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT env var is not set');

  let serviceAccount: object;
  try {
    serviceAccount = JSON.parse(raw);
  } catch {
    throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON');
  }

  _app = getApps().length
    ? getApps()[0]!
    : initializeApp({ credential: cert(serviceAccount as Parameters<typeof cert>[0]) });

  logger.info('FirebaseAdmin: initialized');
  return _app;
}

/**
 * Set or remove the `admin` custom claim for a Firebase user.
 * Pass `true` to grant admin, `false` to revoke.
 */
export async function setAdminClaim(uid: string, value: boolean): Promise<void> {
  getAdminApp();
  await getAuth().setCustomUserClaims(uid, { admin: value });
  logger.info({ uid, admin: value }, 'FirebaseAdmin: custom claim updated');
}

/**
 * Retrieve current custom claims for a user (for verification).
 */
export async function getUserClaims(uid: string): Promise<Record<string, unknown>> {
  getAdminApp();
  const user = await getAuth().getUser(uid);
  return (user.customClaims ?? {}) as Record<string, unknown>;
}
