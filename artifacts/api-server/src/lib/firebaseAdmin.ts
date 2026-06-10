/**
 * Firebase Admin SDK — lazy initializer.
 *
 * Used exclusively for writing Custom Claims.
 * Token verification continues to use the manual RS256 verifier in auth.ts.
 * Requires FIREBASE_SERVICE_ACCOUNT env var (full service-account JSON).
 */

import * as admin from 'firebase-admin';
import { logger } from './logger';

let _app: admin.app.App | null = null;

function getAdminApp(): admin.app.App {
  if (_app) return _app;

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT env var is not set');

  let credential: admin.ServiceAccount;
  try {
    credential = JSON.parse(raw) as admin.ServiceAccount;
  } catch {
    throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON');
  }

  _app = admin.apps.length
    ? admin.apps[0]!
    : admin.initializeApp({ credential: admin.credential.cert(credential) });

  logger.info('FirebaseAdmin: initialized');
  return _app;
}

/**
 * Set or remove the `admin` custom claim for a Firebase user.
 * Pass `true` to grant admin, `false` to revoke.
 */
export async function setAdminClaim(uid: string, value: boolean): Promise<void> {
  const app = getAdminApp();
  await app.auth().setCustomUserClaims(uid, { admin: value });
  logger.info({ uid, admin: value }, 'FirebaseAdmin: custom claim updated');
}

/**
 * Retrieve current custom claims for a user (for verification).
 */
export async function getUserClaims(uid: string): Promise<Record<string, unknown>> {
  const app = getAdminApp();
  const user = await app.auth().getUser(uid);
  return (user.customClaims ?? {}) as Record<string, unknown>;
}
