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
import { triggerQuestionExtraction } from '../lib/questionExtractor';
import { examStore } from '../lib/examStore';
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

// ─── POST /api/admin/recover-exams ───────────────────────────────────────────
// Triggers question extraction for all pending/error exam records.
// Fire-and-forget: returns immediately, extraction runs in background.
router.post('/recover-exams', requireAuth, requireAdmin, async (req, res) => {
  try {
    const records = await examStore.listExamRecords({ userId: req.user!.uid, isAdmin: true });
    const pending = records.filter(r =>
      r.extractionStatus === 'pending' ||
      r.extractionStatus === 'error' ||
      r.extractionStatus === 'extracting'
    );

    if (pending.length === 0) {
      res.json({ message: 'No pending exams found', triggered: 0 });
      return;
    }

    // Trigger extraction for each pending exam sequentially (background)
    const triggered = pending.map(r => ({ examId: r.examId, title: r.title, docId: r.curriculumDocId }));

    // Fire-and-forget with sequential processing and delays
    (async () => {
      for (let i = 0; i < pending.length; i++) {
        const rec = pending[i]!;
        logger.info({ examId: rec.examId, title: rec.title }, 'admin recover-exams: triggering extraction');
        if (i > 0) {
          await new Promise(r => setTimeout(r, 30_000));
        }
        try {
          await triggerQuestionExtraction(rec.curriculumDocId);
        } catch (err) {
          logger.error({ err, examId: rec.examId }, 'admin recover-exams: extraction failed');
        }
      }
      logger.info({ count: pending.length }, 'admin recover-exams: all extractions complete');
    })().catch(err => logger.error({ err }, 'admin recover-exams: background error'));

    res.json({
      message: `Triggered extraction for ${triggered.length} exams`,
      triggered,
    });
  } catch (err) {
    logger.error({ err }, 'admin recover-exams: error');
    res.status(500).json({ error: String(err) });
  }
});

// ─── GET /api/admin/exam-status ───────────────────────────────────────────────
// Returns current extraction status for all exam records (admin only).
router.get('/exam-status', requireAuth, requireAdmin, async (req, res) => {
  try {
    const records = await examStore.listExamRecords({ userId: req.user!.uid, isAdmin: true });
    res.json({
      total: records.length,
      records: records.map(r => ({
        examId: r.examId,
        title: r.title,
        status: r.extractionStatus,
        questionCount: r.questionCount,
        ownerId: r.ownerId,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
