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
import { getExtractionCacheStats, clearExtractionCache } from '../lib/extractionCache';
import { examStore } from '../lib/examStore';
import { logger } from '../lib/logger';
import { grantRole, revokeRole, getUserRoles, listUsersWithRole, type Role } from '../lib/rbac';
import { resetUserBucket, getBucketStatus } from '../middleware/rateLimiter';
import { getBackupHealth, runBackup } from '../lib/backupScheduler';

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

// ─── RBAC Routes ──────────────────────────────────────────────────────────────

// POST /api/admin/roles/grant — grant a role to a user
router.post('/roles/grant', requireAuth, requireAdmin, async (req, res) => {
  const { uid, role } = req.body as { uid?: string; role?: string };
  if (!uid || !role) { res.status(400).json({ error: '`uid` and `role` are required' }); return; }

  const valid: Role[] = ['student','teacher','moderator','admin','super_admin'];
  if (!valid.includes(role as Role)) {
    res.status(400).json({ error: `Invalid role. Must be one of: ${valid.join(', ')}` }); return;
  }

  try {
    await grantRole(uid, role as Role, req.user!.uid);
    res.json({ ok: true, uid, role });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/admin/roles/revoke — revoke a role from a user
router.post('/roles/revoke', requireAuth, requireAdmin, async (req, res) => {
  const { uid, role } = req.body as { uid?: string; role?: string };
  if (!uid || !role) { res.status(400).json({ error: '`uid` and `role` are required' }); return; }

  try {
    await revokeRole(uid, role as Role);
    res.json({ ok: true, uid, role });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/admin/roles/:uid — list all roles for a user
router.get('/roles/:uid', requireAuth, requireAdmin, async (req, res) => {
  try {
    const roles = await getUserRoles(req.params.uid!);
    res.json({ uid: req.params.uid, roles });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/admin/roles/list/:role — list all users with a role
router.get('/roles/list/:role', requireAuth, requireAdmin, async (req, res) => {
  try {
    const users = await listUsersWithRole(req.params.role as Role);
    res.json({ role: req.params.role, users });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── Rate Limit Management ────────────────────────────────────────────────────

// POST /api/admin/rate-limits/reset — reset a user's bucket for an action
router.post('/rate-limits/reset', requireAuth, requireAdmin, async (req, res) => {
  const { uid, action } = req.body as { uid?: string; action?: string };
  if (!uid || !action) { res.status(400).json({ error: '`uid` and `action` are required' }); return; }

  try {
    await resetUserBucket(uid, action);
    res.json({ ok: true, uid, action, message: 'Bucket reset to full capacity' });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/admin/rate-limits/:uid — get bucket status for a user
router.get('/rate-limits/:uid', requireAuth, requireAdmin, async (req, res) => {
  try {
    const status = await getBucketStatus(req.params.uid!);
    res.json({ uid: req.params.uid, buckets: status });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── Backup Management ────────────────────────────────────────────────────────

// GET /api/admin/backup/health — check backup health
router.get('/backup/health', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const health = await getBackupHealth();
    res.json(health);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/admin/backup/run — manually trigger a backup (fire-and-forget)
router.post('/backup/run', requireAuth, requireAdmin, (_req, res) => {
  runBackup().catch(err => logger.error({ err }, 'manual backup: failed'));
  res.json({ ok: true, message: 'Backup started in background — check /backup/health for status' });
});

// ─── GET /api/admin/extraction-report — Phase 8 ───────────────────────────────
// Full end-to-end extraction quality report for all exams.
// Shows: OCR score, coverage, extraction score, dedup stats, cache, failed chunks.
router.get('/extraction-report', requireAuth, requireAdmin, async (req, res) => {
  try {
    const records = await examStore.listExamRecords({ userId: req.user!.uid, isAdmin: true });
    const cache   = getExtractionCacheStats();

    const report = {
      generatedAt:   new Date().toISOString(),
      summary: {
        totalExams:        records.length,
        done:              records.filter(r => r.extractionStatus === 'done').length,
        pending:           records.filter(r => r.extractionStatus === 'pending').length,
        extracting:        records.filter(r => r.extractionStatus === 'extracting').length,
        error:             records.filter(r => r.extractionStatus === 'error').length,
        totalQuestions:    records.reduce((s, r) => s + (r.questionCount ?? 0), 0),
        avgOcrScore:       avg(records.map(r => r.ocrQualityScore ?? 0).filter(Boolean)),
        avgExtractionScore: avg(
          records
            .map(r => (r.ocrDiagnostics as Record<string, unknown> | null)?.extractionScore as { total?: number } | undefined)
            .filter(Boolean)
            .map(s => s!.total ?? 0)
        ),
      },
      cache,
      exams: records.map(r => {
        const diag = r.ocrDiagnostics as Record<string, unknown> | null;
        const score = diag?.extractionScore as { total?: number; grade?: string } | undefined;
        const norm  = diag?.normalization as Record<string, number> | undefined;
        const cov   = diag?.coverage as Record<string, unknown> | undefined;
        const chunks = (diag?.chunks as Array<Record<string, unknown>> | undefined) ?? [];
        return {
          examId:          r.examId,
          title:           r.title,
          status:          r.extractionStatus,
          questionCount:   r.questionCount,
          ocrScore:        r.ocrQualityScore,
          extractionScore: score?.total ?? null,
          grade:           score?.grade ?? null,
          coverageFlag:    cov?.flag ?? null,
          coverageRatio:   cov?.coverageRatio ?? null,
          dedup: {
            exactRemoved: norm?.exactRemoved ?? 0,
            nearRemoved:  norm?.nearRemoved ?? 0,
          },
          chunks: {
            total:     chunks.length,
            succeeded: chunks.filter((c) => (c.extracted as number) > 0).length,
            recovered: chunks.filter((c) => c.recovered).length,
            failed:    chunks.filter((c) => (c.extracted as number) === 0).length,
            cached:    chunks.filter((c) => c.cached).length,
          },
          failureReason: r.failureReason ?? null,
        };
      }),
    };

    res.json(report);
  } catch (err) {
    logger.error({ err }, 'extraction-report: error');
    res.status(500).json({ error: String(err) });
  }
});

// ─── POST /api/admin/cache/clear ──────────────────────────────────────────────
router.post('/cache/clear', requireAuth, requireAdmin, (_req, res) => {
  clearExtractionCache();
  res.json({ ok: true, message: 'Extraction cache cleared' });
});

/** Compute average of a number array, returns 0 for empty. */
function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return Math.round(nums.reduce((s, n) => s + n, 0) / nums.length);
}

export default router;
