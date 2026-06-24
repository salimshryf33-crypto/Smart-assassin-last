/**
 * Admin management routes.
 *
 * POST /api/admin/set-claim  — set or revoke the `admin` custom claim for a UID
 * GET  /api/admin/claims/:uid — verify current claims for a UID
 *
 * All routes require an authenticated admin caller.
 */

import { Router } from 'express';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { setAdminClaim, getUserClaims } from '../lib/firebaseAdmin';
import { triggerQuestionExtraction, DailyQuotaExhaustedError } from '../lib/questionExtractor';
import { getExtractionCacheStats, clearExtractionCache } from '../lib/extractionCache';
import { examStore } from '../lib/examStore';
import { logger } from '../lib/logger';
import { grantRole, revokeRole, getUserRoles, listUsersWithRole, type Role } from '../lib/rbac';
import { resetUserBucket, getBucketStatus } from '../middleware/rateLimiter';
import { getBackupHealth, runBackup } from '../lib/backupScheduler';
import { audit, listAuditLog, type AuditAction } from '../lib/auditLog';
import { getMigrationPool } from '../lib/dbMigrations';
import { getSnapshot as getMetricsSnapshot } from '../services/metricsService';
import { readIndex } from '../lib/curriculumStorage';

const router = Router();

// ─── GET /api/admin/system-health ────────────────────────────────────────────
// Full platform health dashboard — DB, backup, rate limits, memory, uptime.
router.get('/system-health', requireAuth, requireAdmin, async (req, res) => {
  try {
    const db = getMigrationPool();

    // DB connectivity + table counts
    const [dbPing, auditCount, bucketCount, roleCount, backupHealth] = await Promise.all([
      db.query<{ now: Date }>('SELECT now()').then(r => ({ ok: true, ts: r.rows[0]?.now })).catch(() => ({ ok: false, ts: null })),
      db.query<{ count: string }>('SELECT COUNT(*) as count FROM audit_log').then(r => parseInt(r.rows[0]?.count ?? '0', 10)).catch(() => 0),
      db.query<{ count: string }>('SELECT COUNT(*) as count FROM rate_limit_buckets').then(r => parseInt(r.rows[0]?.count ?? '0', 10)).catch(() => 0),
      db.query<{ count: string }>('SELECT COUNT(*) as count FROM user_roles').then(r => parseInt(r.rows[0]?.count ?? '0', 10)).catch(() => 0),
      getBackupHealth(),
    ]);

    const memMB = (bytes: number) => Math.round(bytes / 1024 / 1024);
    const mem   = process.memoryUsage();

    res.json({
      status:    dbPing.ok ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      server: {
        uptimeSeconds: Math.floor(process.uptime()),
        nodeVersion:   process.version,
        platform:      process.platform,
        memory: {
          heapUsedMB:  memMB(mem.heapUsed),
          heapTotalMB: memMB(mem.heapTotal),
          rssMB:       memMB(mem.rss),
        },
        cpus:    os.cpus().length,
        loadAvg: os.loadavg(),
      },
      database: {
        connected:   dbPing.ok,
        serverTime:  dbPing.ts,
        auditEntries:  auditCount,
        rateBuckets:   bucketCount,
        assignedRoles: roleCount,
      },
      backup: backupHealth,
      security: {
        rateLimitingEnabled: true,
        pdfValidationEnabled: true,
        rbacEnabled: true,
        auditLogEnabled: true,
        securityHeadersEnabled: true,
      },
    });
  } catch (err) {
    logger.error({ err }, 'system-health: error');
    res.status(500).json({ error: String(err) });
  }
});

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
    audit({ uid: req.user!.uid, action: 'admin_claim_set', resourceType: 'user', resourceId: uid, metadata: { admin }, req });
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
          await new Promise(r => setTimeout(r, 45_000));
        }
        try {
          await triggerQuestionExtraction(rec.curriculumDocId);
        } catch (err) {
          if (err instanceof DailyQuotaExhaustedError) {
            logger.error({ examId: rec.examId, remaining: pending.length - i - 1 }, 'admin recover-exams: daily quota exhausted — stopping batch');
            break;
          }
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
    audit({ uid: req.user!.uid, action: 'role_grant', resourceType: 'user', resourceId: uid, metadata: { role }, req });
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
    audit({ uid: req.user!.uid, action: 'role_revoke', resourceType: 'user', resourceId: uid, metadata: { role }, req });
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
router.post('/backup/run', requireAuth, requireAdmin, (req, res) => {
  audit({ uid: req.user?.uid, action: 'backup_run', req });
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
router.post('/cache/clear', requireAuth, requireAdmin, (req, res) => {
  clearExtractionCache();
  audit({ uid: req.user?.uid, action: 'cache_clear', req });
  res.json({ ok: true, message: 'Extraction cache cleared' });
});

// ─── GET /api/admin/audit-log ─────────────────────────────────────────────────
// Returns the most recent audit entries. Supports ?uid=, ?action=, ?limit=
router.get('/audit-log', requireAuth, requireAdmin, async (req, res) => {
  try {
    const limit  = Math.min(parseInt(String(req.query['limit'] ?? '100'), 10), 500);
    const uid    = req.query['uid']    as string | undefined;
    const action = req.query['action'] as AuditAction | undefined;

    const entries = await listAuditLog({ limit, uid, action });
    res.json({ total: entries.length, entries });
  } catch (err) {
    logger.error({ err }, 'audit-log: query error');
    res.status(500).json({ error: String(err) });
  }
});

// ─── GET /api/admin/backup/download ──────────────────────────────────────────
// Download the most recent successful backup as a .sql.gz file.
router.get('/backup/download', requireAuth, requireAdmin, async (req, res) => {
  try {
    const db  = getMigrationPool();
    const row = await db.query<{ id: number; started_at: Date; backup_data: Buffer | null; file_size_kb: number | null }>(
      `SELECT id, started_at, backup_data, file_size_kb
       FROM db_backup_log
       WHERE status = 'success' AND backup_data IS NOT NULL
       ORDER BY started_at DESC LIMIT 1`
    );

    if (row.rows.length === 0 || !row.rows[0]?.backup_data) {
      res.status(404).json({ error: 'No backup available yet. Run POST /api/admin/backup/run first.' });
      return;
    }

    const latest = row.rows[0];
    const ts     = latest.started_at.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const name   = `sage-backup-${ts}.sql.gz`;

    audit({ uid: req.user?.uid, action: 'backup_run', metadata: { download: true, backupId: latest.id }, req });

    res.setHeader('Content-Type',        'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    if (latest.file_size_kb) res.setHeader('Content-Length', latest.file_size_kb * 1024);
    res.send(latest.backup_data);
  } catch (err) {
    logger.error({ err }, 'backup/download: error');
    res.status(500).json({ error: String(err) });
  }
});

/** Compute average of a number array, returns 0 for empty. */
function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return Math.round(nums.reduce((s, n) => s + n, 0) / nums.length);
}

// ─── GET /api/admin/metrics ───────────────────────────────────────────────────
// All operational metrics: requests, Gemini, search.
router.get('/metrics', requireAuth, requireAdmin, (_req, res) => {
  try {
    res.json(getMetricsSnapshot());
  } catch (err) {
    logger.error({ err }, 'admin/metrics: error');
    res.status(500).json({ error: String(err) });
  }
});

// ─── GET /api/admin/ai-metrics ────────────────────────────────────────────────
// Gemini-focused: calls today, failures, quota errors, avg latency.
router.get('/ai-metrics', requireAuth, requireAdmin, (_req, res) => {
  try {
    const snap = getMetricsSnapshot();
    res.json({
      generatedAt:   snap.generatedAt,
      gemini:        snap.gemini,
    });
  } catch (err) {
    logger.error({ err }, 'admin/ai-metrics: error');
    res.status(500).json({ error: String(err) });
  }
});

// ─── GET /api/admin/usage-summary ────────────────────────────────────────────
// High-level summary: docs, exams, questions, OCR status, search stats.
router.get('/usage-summary', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const db   = getMigrationPool();
    const snap = getMetricsSnapshot();

    // ── Curriculum docs (in-memory index) ────────────────────────────────────
    const allDocs  = readIndex();
    const books    = allDocs.filter(d => d.docType === 'book' || !d.docType);
    const exams    = allDocs.filter(d => d.docType === 'exam');
    const ocrDone  = allDocs.filter(d => d.status === 'done').length;
    const ocrFail  = allDocs.filter(d => d.status === 'error').length;
    const ocrProc  = allDocs.filter(d => d.status === 'processing' || d.status === 'ocr_running').length;
    const totalChunks = allDocs.reduce((s, d) => s + (d.chunkCount ?? 0), 0);

    // ── PDF files on disk ─────────────────────────────────────────────────────
    const PDF_DIR  = path.resolve('data/pdfs');
    let pdfCount   = 0;
    let pdfSizeKB  = 0;
    try {
      const files = fs.readdirSync(PDF_DIR).filter(f => f.endsWith('.pdf'));
      pdfCount    = files.length;
      pdfSizeKB   = files.reduce((s, f) => {
        try { return s + Math.round(fs.statSync(path.join(PDF_DIR, f)).size / 1024); }
        catch { return s; }
      }, 0);
    } catch { /* PDF dir may not exist */ }

    // ── Exam records from DB ──────────────────────────────────────────────────
    const [questionCount, examRecords] = await Promise.all([
      db.query<{ count: string }>('SELECT COUNT(*) AS count FROM exam_questions')
        .then(r => parseInt(r.rows[0]?.count ?? '0', 10))
        .catch(() => 0),
      db.query<{ extraction_status: string; count: string }>(
        'SELECT extraction_status, COUNT(*) AS count FROM exam_records GROUP BY extraction_status'
      ).then(r => r.rows).catch(() => [] as Array<{ extraction_status: string; count: string }>),
    ]);

    const examsByStatus = Object.fromEntries(
      examRecords.map(r => [r.extraction_status, parseInt(r.count, 10)])
    );

    res.json({
      generatedAt: new Date().toISOString(),
      curriculum: {
        totalDocs:    allDocs.length,
        books:        books.length,
        examDocs:     exams.length,
        totalChunks,
      },
      ocr: {
        done:         ocrDone,
        processing:   ocrProc,
        failed:       ocrFail,
      },
      storage: {
        pdfCount,
        pdfSizeKB,
        pdfSizeMB: Math.round(pdfSizeKB / 1024 * 10) / 10,
      },
      exams: {
        byStatus:     examsByStatus,
        totalDone:    examsByStatus['done']    ?? 0,
        totalPending: examsByStatus['pending'] ?? 0,
        totalError:   examsByStatus['error']   ?? 0,
        questionsExtracted: questionCount,
      },
      search: snap.search,
    });
  } catch (err) {
    logger.error({ err }, 'admin/usage-summary: error');
    res.status(500).json({ error: String(err) });
  }
});

// ─── GET /api/admin/cache-metrics ────────────────────────────────────────────
// Cache hit/miss stats (delegates to existing getCacheHealth).
router.get('/cache-metrics', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const { getCacheHealth } = await import('../services/cacheService');
    const health = await getCacheHealth();
    const m = health.metrics;
    const total = m.hits + m.misses;
    res.json({
      generatedAt: new Date().toISOString(),
      backend:     health.backend ?? 'memory',
      connected:   health.connected ?? true,
      hits:        m.hits,
      misses:      m.misses,
      errors:      m.errors,
      hitRatioPct: total === 0 ? 0 : Math.round((m.hits / total) * 100),
      setOps:      m.setOperations,
      invalidations: m.invalidations,
      savedGeminiCalls: m.savedGeminiCalls,
      inFlightKeys: health.inFlightKeys ?? 0,
    });
  } catch (err) {
    logger.error({ err }, 'admin/cache-metrics: error');
    res.status(500).json({ error: String(err) });
  }
});

// ─── GET /api/admin/cache-health ─────────────────────────────────────────────
// Read-only. Returns Redis/memory backend status + hit/miss metrics.
router.get('/cache-health', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const { getCacheHealth } = await import('../services/cacheService');
    const health = await getCacheHealth();
    res.json(health);
  } catch (err) {
    logger.error({ err }, 'cache-health: error');
    res.status(500).json({ error: String(err) });
  }
});

// ─── POST /api/admin/cache/flush ─────────────────────────────────────────────
// Flush entire cache. Admin only.
router.post('/cache/flush', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { flushAll } = await import('../services/cacheService');
    const deleted = await flushAll();
    audit({ uid: req.user?.uid, action: 'cache_clear', req });
    res.json({ ok: true, deleted });
  } catch (err) {
    logger.error({ err }, 'cache/flush: error');
    res.status(500).json({ error: String(err) });
  }
});

export default router;
