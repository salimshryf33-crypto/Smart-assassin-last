/**
 * rbac middleware — Role-based permission enforcement.
 *
 * Must be used AFTER requireAuth (from middleware/auth.ts).
 * Does NOT replace requireAuth or requireAdmin — purely additive.
 *
 * Usage:
 *   router.post('/route', requireAuth, requireRole('teacher'), handler)
 *   router.delete('/route', requireAuth, requireRole('moderator'), handler)
 */
import { type RequestHandler } from 'express';
import { hasRole, type Role } from '../lib/rbac';
import { isAdmin } from './auth';
import { logger } from '../lib/logger';

/**
 * Middleware: require the user to have at least `minRole`.
 *
 * Admins (existing system) are always allowed regardless of role table —
 * preserves full backward-compatibility with the existing admin check.
 */
export function requireRole(minRole: Role): RequestHandler {
  return async (req, res, next) => {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    // Existing admins always pass — no change to current behavior
    if (isAdmin(user)) {
      next();
      return;
    }

    try {
      const ok = await hasRole(user.uid, minRole);
      if (!ok) {
        logger.warn({ uid: user.uid, required: minRole }, 'rbac: access denied');
        res.status(403).json({
          error:    'Insufficient permissions',
          required: minRole,
        });
        return;
      }
      next();
    } catch (err) {
      // Fail open if DB is unavailable — RBAC is additive, not a hard gate
      logger.error({ err, uid: user.uid, required: minRole }, 'rbac: DB error — failing open');
      next();
    }
  };
}

/**
 * Middleware: require the user to have EXACTLY one of the listed roles.
 * Admins always pass.
 */
export function requireAnyRole(...roles: Role[]): RequestHandler {
  return async (req, res, next) => {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    if (isAdmin(user)) {
      next();
      return;
    }

    try {
      for (const role of roles) {
        const ok = await hasRole(user.uid, role);
        if (ok) { next(); return; }
      }
      res.status(403).json({
        error:    'Insufficient permissions',
        required: roles,
      });
    } catch (err) {
      logger.error({ err, uid: user.uid }, 'rbac: DB error — failing open');
      next();
    }
  };
}
