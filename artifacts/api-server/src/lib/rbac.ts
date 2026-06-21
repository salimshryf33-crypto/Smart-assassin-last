/**
 * rbac — Role-Based Access Control for the Sage platform.
 *
 * IMPORTANT: This does NOT replace the existing auth system.
 * - requireAuth / requireAdmin in middleware/auth.ts remain unchanged.
 * - This adds an optional extra permission layer on top.
 *
 * Role hierarchy (highest to lowest):
 *   super_admin > admin > moderator > teacher > student
 *
 * Usage:
 *   import { grantRole, revokeRole, getUserRoles, hasRole } from '../lib/rbac';
 *   import { requireRole } from '../middleware/rbac';
 *
 *   router.post('/publish', requireAuth, requireRole('moderator'), handler);
 */
import { getMigrationPool } from './dbMigrations';
import { logger } from './logger';

// ─── Types ────────────────────────────────────────────────────────────────────

export type Role = 'student' | 'teacher' | 'moderator' | 'admin' | 'super_admin';

export const ROLE_HIERARCHY: Role[] = [
  'student',
  'teacher',
  'moderator',
  'admin',
  'super_admin',
];

/** Returns true if the user's role meets or exceeds the required role level. */
export function roleAtLeast(userRole: Role, required: Role): boolean {
  return ROLE_HIERARCHY.indexOf(userRole) >= ROLE_HIERARCHY.indexOf(required);
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

export async function grantRole(
  uid: string, role: Role, grantedBy?: string
): Promise<void> {
  const db = getMigrationPool();
  await db.query(
    `INSERT INTO user_roles (uid, role, granted_by) VALUES ($1, $2, $3)
     ON CONFLICT (uid, role) DO NOTHING`,
    [uid, role, grantedBy ?? null]
  );
  logger.info({ uid, role, grantedBy }, 'rbac: role granted');
}

export async function revokeRole(uid: string, role: Role): Promise<void> {
  const db = getMigrationPool();
  await db.query('DELETE FROM user_roles WHERE uid = $1 AND role = $2', [uid, role]);
  logger.info({ uid, role }, 'rbac: role revoked');
}

export async function getUserRoles(uid: string): Promise<Role[]> {
  const db = getMigrationPool();
  const res = await db.query<{ role: Role }>(
    'SELECT role FROM user_roles WHERE uid = $1',
    [uid]
  );
  return res.rows.map(r => r.role);
}

/** Returns the highest role for the user, or 'student' if none assigned. */
export async function getHighestRole(uid: string): Promise<Role> {
  const roles = await getUserRoles(uid);
  if (roles.length === 0) return 'student';

  let highest: Role = 'student';
  for (const role of roles) {
    if (roleAtLeast(role, highest)) highest = role;
  }
  return highest;
}

/** Check if a user has at least the given role level. */
export async function hasRole(uid: string, required: Role): Promise<boolean> {
  const highest = await getHighestRole(uid);
  return roleAtLeast(highest, required);
}

/** List all users with a specific role. */
export async function listUsersWithRole(role: Role): Promise<Array<{
  uid: string; role: Role; grantedBy: string | null; createdAt: Date;
}>> {
  const db = getMigrationPool();
  const res = await db.query<{
    uid: string; role: Role; granted_by: string | null; created_at: Date;
  }>(
    'SELECT uid, role, granted_by, created_at FROM user_roles WHERE role = $1 ORDER BY created_at',
    [role]
  );
  return res.rows.map(r => ({
    uid:       r.uid,
    role:      r.role,
    grantedBy: r.granted_by,
    createdAt: r.created_at,
  }));
}
