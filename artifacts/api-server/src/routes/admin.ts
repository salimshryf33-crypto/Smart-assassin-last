/**
 * Admin management routes.
 *
 * POST /api/admin/set-claim  — set or revoke the `admin` custom claim for a UID
 * GET  /api/admin/claims/:uid — verify current claims for a UID
 *
 * All routes require an authenticated admin caller.
 */

import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { setAdminClaim, getUserClaims } from '../lib/firebaseAdmin';
import { logger } from '../lib/logger';

const router = Router();

// ─── POST /api/admin/set-claim ────────────────────────────────────────────────
router.post('/set-claim', requireAuth, requireAdmin, async (req, res) => {
  const { uid, admin } = req.body as { uid?: string; admin?: boolean };

  if (!uid || typeof uid !== 'string') {
    res.status(400).json({ error: '`uid` (string) is required' });
    return;
  }
  if (typeof admin !== 'boolean') {
    res.status(400).json({ error: '`admin` (boolean) is required' });
    return;
  }

  try {
    await setAdminClaim(uid, admin);
    logger.info({ callerUid: req.user!.uid, targetUid: uid, admin }, 'Admin claim updated');
    res.json({ ok: true, uid, admin });
  } catch (err) {
    logger.error({ err }, 'Failed to set admin claim');
    res.status(500).json({ error: String(err) });
  }
});

// ─── GET /api/admin/claims/:uid ───────────────────────────────────────────────
router.get('/claims/:uid', requireAuth, requireAdmin, async (req, res) => {
  const { uid } = req.params as { uid: string };

  try {
    const claims = await getUserClaims(uid);
    res.json({ uid, claims });
  } catch (err) {
    logger.error({ err }, 'Failed to get user claims');
    res.status(500).json({ error: String(err) });
  }
});

export default router;
