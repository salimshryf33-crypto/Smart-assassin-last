/**
 * routes/curriculumLinks.ts
 *
 * Curriculum Linking Admin API — Phase 2
 *
 * All routes require authentication + admin role.
 *
 * GET  /api/curriculum-links              — list all links (with optional ?status= filter)
 * GET  /api/curriculum-links/stats        — aggregate counts by status
 * GET  /api/curriculum-links/pending      — shortcut for status=pending_review
 * GET  /api/curriculum-links/weights      — current matcher weights
 * GET  /api/curriculum-links/candidates/:examId  — run fresh match, return ranked candidates
 * POST /api/curriculum-links/:examId/approve     — approve current best (or body.docId override)
 * POST /api/curriculum-links/:examId/manual      — manual link to body.docId
 * POST /api/curriculum-links/:examId/reject      — reject + rematch
 * POST /api/curriculum-links/:examId/rematch     — force fresh rematch
 */

import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth';
import {
  getLinkByExam,
  listLinks,
  listPendingLinks,
  getStats,
  approveLink,
  rejectAndRematch,
  manualLink,
  matchAndLink,
  scanUnlinkedExams,
}                                    from '../lib/curriculumLinker';
import { matchExamToCurriculum }     from '../lib/curriculumMatcher';
import { loadWeights }               from '../lib/curriculumMatcher';
import { logger }                    from '../lib/logger';
import type { LinkStatus }           from '../lib/curriculumLinker';

const router = Router();

// ─── GET /api/curriculum-links ─────────────────────────────────────────────────
router.get('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    const status  = req.query['status']  as LinkStatus | undefined;
    const limit   = Math.min(parseInt(req.query['limit']  as string ?? '100', 10), 500);
    const offset  = parseInt(req.query['offset'] as string ?? '0', 10);

    const links = await listLinks({ status, limit, offset });
    res.json({ links, count: links.length });
  } catch (err) {
    logger.error({ err }, 'GET /curriculum-links: error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/curriculum-links/stats ─────────────────────────────────────────
router.get('/stats', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const stats = await getStats();
    res.json(stats);
  } catch (err) {
    logger.error({ err }, 'GET /curriculum-links/stats: error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/curriculum-links/pending ───────────────────────────────────────
router.get('/pending', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const links = await listPendingLinks();
    res.json({ links, count: links.length });
  } catch (err) {
    logger.error({ err }, 'GET /curriculum-links/pending: error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/curriculum-links/weights ───────────────────────────────────────
router.get('/weights', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const weights = await loadWeights();
    res.json({
      weights,
      components: ['metadata (40)', 'keywords (35)', 'chapters (20)', 'temporal (5)'],
      description: 'Adaptive weights for the curriculum matching algorithm. Updated automatically on each admin approval/rejection.',
    });
  } catch (err) {
    logger.error({ err }, 'GET /curriculum-links/weights: error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/curriculum-links/candidates/:examId ────────────────────────────
router.get('/candidates/:examId', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { examId } = req.params as { examId: string };
    const result     = await matchExamToCurriculum(examId);
    const existing   = await getLinkByExam(examId);

    res.json({
      examId,
      existing,
      candidates:    result.candidates,
      bestCandidate: result.bestCandidate,
      autoApproved:  result.autoApproved,
      computedAt:    result.computedAt,
    });
  } catch (err) {
    logger.error({ err }, 'GET /curriculum-links/candidates: error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/curriculum-links/:examId ───────────────────────────────────────
router.get('/:examId', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { examId } = req.params as { examId: string };
    const link = await getLinkByExam(examId);

    if (!link) {
      res.status(404).json({ error: 'No link found for this exam' }); return;
    }
    res.json(link);
  } catch (err) {
    logger.error({ err }, 'GET /curriculum-links/:examId: error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /api/curriculum-links/:examId/approve ──────────────────────────────
router.post('/:examId/approve', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { examId }  = req.params as { examId: string };
    const { docId }   = req.body as { docId?: string };
    const approvedBy  = req.user!.uid;

    const link = await approveLink(examId, docId ?? null, approvedBy);
    logger.info({ examId, docId, approvedBy }, 'curriculum-links: approved via API');
    res.json({ success: true, link });
  } catch (err) {
    logger.error({ err }, 'POST /curriculum-links/approve: error');
    res.status(500).json({ error: String(err) });
  }
});

// ─── POST /api/curriculum-links/:examId/manual ───────────────────────────────
router.post('/:examId/manual', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { examId }  = req.params as { examId: string };
    const { docId }   = req.body as { docId?: string };
    const approvedBy  = req.user!.uid;

    if (!docId?.trim()) {
      res.status(400).json({ error: 'docId is required' }); return;
    }

    const link = await manualLink(examId, docId.trim(), approvedBy);
    logger.info({ examId, docId, approvedBy }, 'curriculum-links: manually linked via API');
    res.json({ success: true, link });
  } catch (err) {
    logger.error({ err }, 'POST /curriculum-links/manual: error');
    res.status(500).json({ error: String(err) });
  }
});

// ─── POST /api/curriculum-links/:examId/reject ───────────────────────────────
router.post('/:examId/reject', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { examId } = req.params as { examId: string };
    const approvedBy = req.user!.uid;

    await rejectAndRematch(examId, approvedBy);
    logger.info({ examId, approvedBy }, 'curriculum-links: rejected + rematch triggered');
    res.json({ success: true, message: 'Link rejected. Fresh match is running in the background.' });
  } catch (err) {
    logger.error({ err }, 'POST /curriculum-links/reject: error');
    res.status(500).json({ error: String(err) });
  }
});

// ─── POST /api/curriculum-links/:examId/rematch ──────────────────────────────
router.post('/:examId/rematch', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { examId } = req.params as { examId: string };

    // Fire-and-forget
    matchAndLink(examId).catch((err) =>
      logger.error({ err, examId }, 'curriculum-links: rematch failed')
    );

    res.json({ success: true, message: 'Rematch triggered — check back shortly.' });
  } catch (err) {
    logger.error({ err }, 'POST /curriculum-links/rematch: error');
    res.status(500).json({ error: String(err) });
  }
});

// ─── POST /api/curriculum-links/rematch-all ───────────────────────────────────
// Re-runs matching for every exam with no_match status or no link at all.
// Useful after fixing the matching algorithm to recover previously failed links.
router.post('/rematch-all', requireAuth, requireAdmin, async (_req, res) => {
  try {
    // Fire-and-forget
    scanUnlinkedExams().catch((err) =>
      logger.error({ err }, 'curriculum-links: rematch-all failed')
    );
    logger.info('curriculum-links: rematch-all triggered by admin');
    res.json({ success: true, message: 'Rematch-all triggered — all no_match exams will be reprocessed.' });
  } catch (err) {
    logger.error({ err }, 'POST /curriculum-links/rematch-all: error');
    res.status(500).json({ error: String(err) });
  }
});

export default router;
