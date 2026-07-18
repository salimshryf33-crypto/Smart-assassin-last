/**
 * Exam Bank API routes
 *
 * GET    /api/exams/records                         — list exam records visible to caller
 * GET    /api/exams/records/:examId                 — single exam record
 * DELETE /api/exams/records/:examId                 — delete exam record + questions (admin or owner)
 * GET    /api/exams/records/:examId/questions       — list questions for an exam
 * GET    /api/exams/questions                       — search questions by country/grade/subject
 * DELETE /api/exams/questions/:id                   — delete a single question (admin only)
 * POST   /api/exams/records/:examId/retry           — retry extraction (admin)
 * GET    /api/exams/records/:examId/validation      — canonical answer validation status (admin)
 * POST   /api/exams/records/:examId/validate        — trigger validation pipeline (admin)
 * POST   /api/exams/records/:examId/publish         — safely publish exam (admin/owner); blocks if not READY
 */
import { Router } from 'express';
import { examStore } from '../lib/examStore';
import { triggerQuestionExtraction } from '../lib/questionExtractor';
import { requireAuth, requireAdmin, isAdmin } from '../middleware/auth';
import { loadChunks } from '../lib/curriculumStorage';
import { analyzeOcrText, detectQuestionPatterns } from '../lib/ocrQualityAnalyzer';
import {
  getPublishReadiness,
  listByExamId        as listCanonicalAnswers,
  runValidationForExam,
  DailyQuotaExhaustedError,
  enqueueExam,
  getQueueOverview,
  listPendingJobs,
  getPreparationSummary,
  listDLQ,
  getDLQStats,
  resolveDLQ,
  recordDLQRetry,
  insertDLQ,
} from '../lib/examValidation';
import { syncPreparationStatus } from '../lib/examValidation/examPreparationStatus';
import { getJobByExamId } from '../lib/examValidation/preparationQueue';
import { generateIntegrityReport } from '../lib/integrity/integrityChecker';
import { evaluatePublishGate } from '../lib/integrity/publishGate';
import { listVersions } from '../lib/integrity/canonicalVersionStore';
import { getRecentMetrics, getAuditLog } from '../lib/observability/metricsQueries';
import { checkHealth } from '../lib/observability/healthEndpoints';
import { ok, fail } from '../lib/validation/responseEnvelope';
import { getSharedPool } from '../lib/dbPool';
import { v4 as uuidv4 } from 'uuid';

const router = Router();

const str = (v: string | string[] | undefined): string =>
  Array.isArray(v) ? (v[0] ?? '') : (v ?? '');

// ─── GET /api/exams/records ───────────────────────────────────────────────────
router.get('/records', requireAuth, async (req, res) => {
  try {
    const records = await examStore.listExamRecords({
      userId:  req.user!.uid,
      isAdmin: isAdmin(req.user!),
    });
    res.json(records);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ─── GET /api/exams/records/:examId ──────────────────────────────────────────
router.get('/records/:examId', requireAuth, async (req, res) => {
  try {
    const record = await examStore.getExamRecord(str(req.params.examId));
    if (!record) { res.status(404).json({ error: 'Exam record not found' }); return; }

    const uid = req.user!.uid;
    if (record.visibility === 'private' && record.ownerId !== uid && !isAdmin(req.user!)) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }
    res.json(record);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ─── DELETE /api/exams/records/:examId ───────────────────────────────────────
router.delete('/records/:examId', requireAuth, async (req, res) => {
  try {
    const examId = str(req.params.examId);
    const record = await examStore.getExamRecord(examId);
    if (!record) { res.status(404).json({ error: 'Exam record not found' }); return; }

    const uid    = req.user!.uid;
    const admin  = isAdmin(req.user!);
    const canDel = admin || (record.visibility === 'private' && record.ownerId === uid);
    if (!canDel) { res.status(403).json({ error: 'Access denied' }); return; }

    await examStore.deleteExamRecord(examId);
    req.log.info({ examId, deletedBy: uid }, 'Deleted exam record + questions');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ─── GET /api/exams/records/:examId/questions ─────────────────────────────────
router.get('/records/:examId/questions', requireAuth, async (req, res) => {
  try {
    const examId = str(req.params.examId);
    const record = await examStore.getExamRecord(examId);
    if (!record) { res.status(404).json({ error: 'Exam record not found' }); return; }

    const uid = req.user!.uid;
    if (record.visibility === 'private' && record.ownerId !== uid && !isAdmin(req.user!)) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const questions = await examStore.getQuestionsByExam(examId);
    res.json({ questions, count: questions.length });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ─── GET /api/exams/questions ─────────────────────────────────────────────────
// Query params: country, grade, subject — all optional; omit = no filter on that field.
router.get('/questions', requireAuth, async (req, res) => {
  const { country, grade, subject } = req.query as Record<string, string>;
  try {
    const questions = await examStore.searchQuestions({
      country:  country  || undefined,
      grade:    grade    || undefined,
      subject:  subject  || undefined,
      userId:   req.user!.uid,
      isAdmin:  isAdmin(req.user!),
    });
    res.json({ questions, count: questions.length });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ─── DELETE /api/exams/questions/:id ─────────────────────────────────────────
router.delete('/questions/:id', requireAuth, async (req, res) => {
  try {
    const qId = str(req.params.id);
    // Ownership check: admin can delete any; owners can't delete individual questions
    // unless they own the exam. For simplicity: admin-only for individual question delete.
    if (!isAdmin(req.user!)) {
      res.status(403).json({ error: 'Admin access required to delete individual questions' });
      return;
    }
    await examStore.deleteQuestionById(qId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ─── GET /api/exams/records/:examId/coverage ─────────────────────────────────
// Returns per-chunk extraction diagnostics so the UI can show exactly where
// questions were found, where OCR was weak, and why chunks produced 0 questions.
router.get('/records/:examId/coverage', requireAuth, async (req, res) => {
  try {
    const examId = str(req.params.examId);
    const record = await examStore.getExamRecord(examId);
    if (!record) { res.status(404).json({ error: 'Exam record not found' }); return; }

    const uid = req.user!.uid;
    if (record.visibility === 'private' && record.ownerId !== uid && !isAdmin(req.user!)) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    // Load actual chunks to get content + pageRange
    const chunks = loadChunks(record.curriculumDocId);

    // ocrDiagnostics stored by questionExtractor — has per-chunk extraction results
    type StoredChunkDiag = {
      chunkIndex: number;
      chars: number;
      arabicWords: number;
      questionPatterns: number;
      extracted: number;
      retried: boolean;
    };
    type OcrDiagnostics = {
      ocrScore?: { score: number; arabicWords: number; uniqueWordRatio: number };
      chunkCount?: number;
      chunksAttempted?: number;
      chunks?: StoredChunkDiag[];
    };

    const diag = (record.ocrDiagnostics ?? {}) as OcrDiagnostics;
    const storedChunks: StoredChunkDiag[] = diag.chunks ?? [];

    // Build indexed map for fast lookup
    const storedByIndex = new Map<number, StoredChunkDiag>();
    for (const c of storedChunks) storedByIndex.set(c.chunkIndex, c);

    // Per-chunk analysis: merge stored diagnostics with live OCR quality analysis
    const chunkDetails = chunks.map((chunk) => {
      const stored = storedByIndex.get(chunk.chunkIndex);
      const ocrQual = analyzeOcrText(chunk.content);
      const patterns = detectQuestionPatterns(chunk.content);

      // Determine why a zero-question chunk failed
      let failureReason: string | null = null;
      if (stored && stored.extracted === 0) {
        const meaningful = chunk.content.replace(/\.{2,}/g, '').replace(/\s+/g, '').trim();
        if (chunk.content.trim().length < 80) {
          failureReason = 'محتوى قصير جداً — تم التخطي (أقل من 80 حرف)';
        } else if (meaningful.length < 30) {
          failureReason = 'صفحة نقاط فقط — لا توجد أسئلة قابلة للاستخراج';
        } else if (ocrQual.isLowConfidence) {
          failureReason = `جودة OCR منخفضة (${Math.round(ocrQual.score)}/100) — ${ocrQual.reason}`;
        } else if (patterns.count === 0) {
          failureReason = 'لم يتم اكتشاف أنماط أسئلة في النص';
        } else if (stored.retried) {
          failureReason = 'فشل الاستخراج حتى بعد إعادة المحاولة بالـ prompt الأكثر عدوانية';
        } else {
          failureReason = 'Gemini لم يُرجع أسئلة من هذا الجزء';
        }
      } else if (!stored) {
        // Chunk was skipped before even hitting Gemini
        const meaningful = chunk.content.replace(/\.{2,}/g, '').replace(/\s+/g, '').trim();
        if (chunk.content.trim().length < 80) {
          failureReason = 'محتوى قصير جداً — تم التخطي';
        } else if (meaningful.length < 30) {
          failureReason = 'صفحة نقاط فقط — تم التخطي';
        } else {
          failureReason = 'لم يتم معالجة هذا الجزء';
        }
      }

      return {
        chunkIndex:      chunk.chunkIndex,
        pageRange:       chunk.pageRange,
        chars:           chunk.content.length,
        arabicWords:     stored?.arabicWords ?? ocrQual.arabicWordCount,
        questionPatterns: stored?.questionPatterns ?? patterns.count,
        extracted:       stored?.extracted ?? 0,
        retried:         stored?.retried ?? false,
        ocrScore:        Math.round(ocrQual.score),
        isLowConfidence: ocrQual.isLowConfidence,
        dotRatio:        Math.round(ocrQual.dotRatio * 100),
        failureReason,
        patternDetail: {
          hasNumberedItems: patterns.hasNumberedItems,
          hasQuestionWords: patterns.hasQuestionWords,
          hasQuestionMarks: patterns.hasQuestionMarks,
          hasMcqOptions:    patterns.hasMcqOptions,
        },
      };
    });

    const totalExtracted  = chunkDetails.reduce((s, c) => s + c.extracted, 0);
    const zeroChunks      = chunkDetails.filter((c) => c.extracted === 0 && c.failureReason !== null);
    const lowConfChunks   = chunkDetails.filter((c) => c.isLowConfidence);

    res.json({
      examId,
      title:             record.title,
      extractionStatus:  record.extractionStatus,
      questionCount:     record.questionCount,
      ocrQualityScore:   record.ocrQualityScore ?? null,
      extractionAttempts: record.extractionAttempts ?? null,
      failureReason:     record.failureReason ?? null,
      totalChunks:       chunks.length,
      chunksAttempted:   diag.chunksAttempted ?? storedChunks.length,
      totalExtracted,
      zeroChunkCount:    zeroChunks.length,
      lowConfChunkCount: lowConfChunks.length,
      chunks:            chunkDetails,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ─── POST /api/exams/records/:examId/retry ────────────────────────────────────
// Admin only — re-trigger extraction for a failed/pending exam record.
router.post('/records/:examId/retry', requireAuth, requireAdmin, async (req, res) => {
  try {
    const examId = str(req.params.examId);
    const record = await examStore.getExamRecord(examId);
    if (!record) { res.status(404).json({ error: 'Exam record not found' }); return; }

    if (record.extractionStatus === 'extracting') {
      res.status(409).json({ error: 'Extraction already in progress' });
      return;
    }

    // Delete existing questions and re-trigger
    await examStore.deleteQuestionsByExam(examId);
    triggerQuestionExtraction(record.curriculumDocId).catch(() => undefined);

    req.log.info({ examId, docId: record.curriculumDocId }, 'Exam extraction retry queued');
    res.status(202).json({ examId, status: 'extracting', message: 'Re-extraction queued' });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ─── GET /api/exams/records/:examId/validation ───────────────────────────────
// Returns canonical answer validation status for every MCQ question in an exam.
// Admin-only — exposes internal confidence scores and evidence references.
router.get('/records/:examId/validation', requireAuth, requireAdmin, async (req, res) => {
  try {
    const examId = str(req.params.examId);
    const record = await examStore.getExamRecord(examId);
    if (!record) { res.status(404).json({ error: 'Exam record not found' }); return; }

    const [readiness, canonicalAnswers] = await Promise.all([
      getPublishReadiness(examId),
      listCanonicalAnswers(examId),
    ]);

    res.json({
      examId,
      title:           record.title,
      questionCount:   record.questionCount,
      readiness,
      canonicalAnswers,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ─── POST /api/exams/records/:examId/validate ────────────────────────────────
// Admin-only — manually trigger the validation pipeline for an exam.
// Useful for retrying LOW_EVIDENCE questions after curriculum is updated.
router.post('/records/:examId/validate', requireAuth, requireAdmin, async (req, res) => {
  try {
    const examId = str(req.params.examId);
    const record = await examStore.getExamRecord(examId);
    if (!record) { res.status(404).json({ error: 'Exam record not found' }); return; }

    if (record.extractionStatus !== 'done') {
      res.status(409).json({ error: 'Exam extraction not yet complete' });
      return;
    }

    // Fire-and-forget so the endpoint returns immediately
    runValidationForExam(examId).catch((err: unknown) => {
      if (err instanceof DailyQuotaExhaustedError) {
        req.log.warn({ examId }, 'validate: Gemini daily quota exhausted mid-run');
      } else {
        req.log.error({ err, examId }, 'validate: pipeline error');
      }
    });

    req.log.info({ examId }, 'validate: pipeline queued');
    res.status(202).json({ examId, status: 'validating', message: 'Validation pipeline queued' });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ─── POST /api/exams/records/:examId/publish ─────────────────────────────────
// Safely publish an exam. Blocks if any MCQ question is not READY.
// Admin or owner of a private exam may publish.
router.post('/records/:examId/publish', requireAuth, async (req, res) => {
  try {
    const examId = str(req.params.examId);
    const record = await examStore.getExamRecord(examId);
    if (!record) { res.status(404).json({ error: 'Exam record not found' }); return; }

    const uid   = req.user!.uid;
    const admin = isAdmin(req.user!);
    const owner = record.ownerId === uid;

    if (!admin && !owner) {
      res.status(403).json({ error: 'Only the owner or an admin may publish this exam' });
      return;
    }

    if (record.extractionStatus !== 'done') {
      res.status(409).json({ error: 'Exam extraction not yet complete' });
      return;
    }

    if ((record.questionCount ?? 0) === 0) {
      res.status(422).json({ error: 'Exam has no questions — cannot publish' });
      return;
    }

    // Safety gate: ensure all MCQ questions have canonical answers
    const readiness = await getPublishReadiness(examId);

    if (!readiness.ready) {
      res.status(422).json({
        error: 'Exam is not ready to publish — some MCQ questions lack validated canonical answers',
        readiness,
      });
      return;
    }

    await examStore.upsertExamRecord({ ...record, visibility: 'public' });

    req.log.info({ examId, publishedBy: uid }, 'exam published');
    res.json({ examId, visibility: 'public', readiness });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 4/5 — Enterprise Integrity & Observability Layer (additive, admin-only)
// All routes below use the standard { success, errorCode, message, details,
// timestamp } response envelope. Existing routes above are unchanged.
// ═══════════════════════════════════════════════════════════════════════════

// ─── GET /api/exams/records/:examId/integrity-report ─────────────────────────
router.get('/records/:examId/integrity-report', requireAuth, requireAdmin, async (req, res) => {
  try {
    const examId = str(req.params.examId);
    const record = await examStore.getExamRecord(examId);
    if (!record) { res.status(404).json(fail('EXAM_NOT_FOUND', 'Exam record not found')); return; }

    const report = await generateIntegrityReport(examId);
    res.json(ok(report));
  } catch (err) {
    res.status(500).json(fail('INTEGRITY_REPORT_FAILED', err instanceof Error ? err.message : String(err)));
  }
});

// ─── GET /api/exams/records/:examId/publish-readiness ────────────────────────
// Extended readiness check (Phase 4) — does not replace the existing gate
// inside POST /publish; this is a read-only preview for admin dashboards.
router.get('/records/:examId/publish-readiness', requireAuth, requireAdmin, async (req, res) => {
  try {
    const examId = str(req.params.examId);
    const record = await examStore.getExamRecord(examId);
    if (!record) { res.status(404).json(fail('EXAM_NOT_FOUND', 'Exam record not found')); return; }

    const gate = await evaluatePublishGate(examId);
    res.json(ok(gate));
  } catch (err) {
    res.status(500).json(fail('PUBLISH_READINESS_FAILED', err instanceof Error ? err.message : String(err)));
  }
});

// ─── POST /api/exams/records/:examId/publish-gated ────────────────────────────
// Strict Phase 4 publish path. Blocks on ANY critical integrity issue, in
// addition to the pre-existing readiness check. Records blocked attempts.
router.post('/records/:examId/publish-gated', requireAuth, requireAdmin, async (req, res) => {
  try {
    const examId = str(req.params.examId);
    const record = await examStore.getExamRecord(examId);
    if (!record) { res.status(404).json(fail('EXAM_NOT_FOUND', 'Exam record not found')); return; }

    const gate = await evaluatePublishGate(examId);

    if (!gate.canPublish) {
      const pool = getSharedPool();
      await pool.query(
        `INSERT INTO public.publish_blocks (id, exam_id, blocking_reasons, attempted_by)
         VALUES ($1, $2, $3, $4)`,
        [uuidv4(), examId, JSON.stringify(gate.reasons), req.user!.uid],
      );
      res.status(422).json(fail('PUBLISH_BLOCKED', 'Exam blocked from publishing by the integrity gate', gate));
      return;
    }

    await examStore.upsertExamRecord({ ...record, visibility: 'public' });
    await getSharedPool().query(
      `UPDATE public.exam_records SET publish_status = 'published' WHERE exam_id = $1`,
      [examId],
    );

    req.log.info({ examId, publishedBy: req.user!.uid }, 'exam published via gated pipeline');
    res.json(ok({ examId, visibility: 'public', gate }));
  } catch (err) {
    res.status(500).json(fail('PUBLISH_GATED_FAILED', err instanceof Error ? err.message : String(err)));
  }
});

// ─── GET /api/exams/questions/:id/answer-versions ─────────────────────────────
router.get('/questions/:id/answer-versions', requireAuth, requireAdmin, async (req, res) => {
  try {
    const questionId = str(req.params.id);
    const versions = await listVersions(questionId);
    res.json(ok({ questionId, versions }));
  } catch (err) {
    res.status(500).json(fail('VERSION_HISTORY_FAILED', err instanceof Error ? err.message : String(err)));
  }
});

// ─── GET /api/exams/observability/metrics ─────────────────────────────────────
router.get('/observability/metrics', requireAuth, requireAdmin, async (req, res) => {
  try {
    const hours = req.query.hours ? parseInt(str(req.query.hours as string | string[] | undefined), 10) : 24;
    const metrics = await getRecentMetrics(Number.isFinite(hours) && hours > 0 ? hours : 24);
    res.json(ok({ metrics }));
  } catch (err) {
    res.status(500).json(fail('METRICS_FAILED', err instanceof Error ? err.message : String(err)));
  }
});

// ─── GET /api/exams/observability/audit-log ───────────────────────────────────
router.get('/observability/audit-log', requireAuth, requireAdmin, async (req, res) => {
  try {
    const examId     = str(req.query.examId as string | string[] | undefined) || undefined;
    const questionId = str(req.query.questionId as string | string[] | undefined) || undefined;
    const limitRaw    = str(req.query.limit as string | string[] | undefined);
    const limit       = limitRaw ? parseInt(limitRaw, 10) : undefined;

    const entries = await getAuditLog({ examId, questionId, limit });
    res.json(ok({ entries }));
  } catch (err) {
    res.status(500).json(fail('AUDIT_LOG_FAILED', err instanceof Error ? err.message : String(err)));
  }
});

// ─── GET /api/exams/observability/health ──────────────────────────────────────
// Extended health check — public (no admin required), read-only.
router.get('/observability/health', async (_req, res) => {
  try {
    const report = await checkHealth();
    res.status(report.status === 'ok' ? 200 : 503).json(ok(report));
  } catch (err) {
    res.status(503).json(fail('HEALTH_CHECK_FAILED', err instanceof Error ? err.message : String(err)));
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 6 — Preparation-First Pipeline Admin Endpoints
// All endpoints below are admin-only and read-only (GET) or action-safe (POST).
// No student-facing routes are altered.
// ═══════════════════════════════════════════════════════════════════════════════

// ─── GET /api/exams/admin/preparation/overview ────────────────────────────────
// Queue depth, worker status, DLQ stats — the admin monitoring dashboard.
router.get('/admin/preparation/overview', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const [queue, dlq, pending] = await Promise.all([
      getQueueOverview(),
      getDLQStats(),
      listPendingJobs(10),
    ]);
    res.json(ok({ queue, dlq, pending }));
  } catch (err) {
    res.status(500).json(fail('PREP_OVERVIEW_FAILED', err instanceof Error ? err.message : String(err)));
  }
});

// ─── GET /api/exams/admin/preparation/:examId ─────────────────────────────────
// Per-exam preparation status: question breakdown + active job.
router.get('/admin/preparation/:examId', requireAuth, requireAdmin, async (req, res) => {
  try {
    const examId = str(req.params.examId);
    const [summary, job] = await Promise.all([
      getPreparationSummary(examId),
      getJobByExamId(examId),
    ]);
    res.json(ok({ summary, job }));
  } catch (err) {
    res.status(500).json(fail('PREP_STATUS_FAILED', err instanceof Error ? err.message : String(err)));
  }
});

// ─── POST /api/exams/admin/preparation/:examId/enqueue ────────────────────────
// Manually enqueue (or re-enqueue) an exam for preparation.
router.post('/admin/preparation/:examId/enqueue', requireAuth, requireAdmin, async (req, res) => {
  try {
    const examId   = str(req.params.examId);
    const priority = typeof req.body?.priority === 'number' ? req.body.priority : 5;
    const record   = await examStore.getExamRecord(examId);
    if (!record) { res.status(404).json(fail('NOT_FOUND', 'Exam not found')); return; }

    const job = await enqueueExam(examId, priority);
    // Kick off validation in the background (fire-and-forget)
    runValidationForExam(examId).then(() => syncPreparationStatus(examId)).catch(() => undefined);
    res.json(ok({ job }));
  } catch (err) {
    res.status(500).json(fail('ENQUEUE_FAILED', err instanceof Error ? err.message : String(err)));
  }
});

// ─── GET /api/exams/admin/preparation/:examId/questions ──────────────────────
// Per-question canonical answer status for one exam — detailed breakdown.
router.get('/admin/preparation/:examId/questions', requireAuth, requireAdmin, async (req, res) => {
  try {
    const examId = str(req.params.examId);
    const answers = await listCanonicalAnswers(examId);
    res.json(ok({ examId, count: answers.length, answers }));
  } catch (err) {
    res.status(500).json(fail('PREP_QUESTIONS_FAILED', err instanceof Error ? err.message : String(err)));
  }
});

// ─── GET /api/exams/admin/dlq ─────────────────────────────────────────────────
// Dead Letter Queue listing with optional filtering.
router.get('/admin/dlq', requireAuth, requireAdmin, async (req, res) => {
  try {
    const examId        = str(req.query.examId as string | string[] | undefined) || undefined;
    const unresolvedOnly = str(req.query.unresolved as string | string[] | undefined) !== 'false';
    const limitRaw      = str(req.query.limit as string | string[] | undefined);
    const offsetRaw     = str(req.query.offset as string | string[] | undefined);
    const limit         = limitRaw  ? parseInt(limitRaw,  10) : 50;
    const offset        = offsetRaw ? parseInt(offsetRaw, 10) : 0;

    const result = await listDLQ({ examId, unresolvedOnly, limit, offset });
    res.json(ok(result));
  } catch (err) {
    res.status(500).json(fail('DLQ_LIST_FAILED', err instanceof Error ? err.message : String(err)));
  }
});

// ─── POST /api/exams/admin/dlq/:questionId/retry ──────────────────────────────
// Manually retry a DLQ question by resetting its canonical answer to PENDING
// and recording the retry on the DLQ entry.
router.post('/admin/dlq/:questionId/retry', requireAuth, requireAdmin, async (req, res) => {
  try {
    const questionId = str(req.params.questionId);
    const pool       = getSharedPool();

    // Reset the canonical answer status to PENDING so the pipeline re-processes it
    await pool.query(
      `UPDATE public.exam_canonical_answers
       SET validation_status = 'PENDING',
           attempt_count     = 0,
           next_retry_at     = NOW(),
           updated_at        = NOW()
       WHERE question_id = $1`,
      [questionId],
    );

    // Record the retry on the DLQ entry
    await recordDLQRetry(questionId);

    // Find the exam and kick off validation
    const { rows } = await pool.query<{ exam_id: string }>(
      `SELECT exam_id FROM public.exam_questions WHERE id = $1 LIMIT 1`,
      [questionId],
    );
    const examId = rows[0]?.exam_id;
    if (examId) {
      runValidationForExam(examId).then(() => syncPreparationStatus(examId)).catch(() => undefined);
    }

    res.json(ok({ questionId, examId, reset: true }));
  } catch (err) {
    res.status(500).json(fail('DLQ_RETRY_FAILED', err instanceof Error ? err.message : String(err)));
  }
});

// ─── POST /api/exams/admin/dlq/:questionId/resolve ────────────────────────────
// Mark a DLQ entry as resolved (admin acknowledgement — no retry).
router.post('/admin/dlq/:questionId/resolve', requireAuth, requireAdmin, async (req, res) => {
  try {
    const questionId = str(req.params.questionId);
    const resolvedBy = req.user!.uid;
    const note       = typeof req.body?.note === 'string' ? req.body.note : 'Resolved by admin';

    await resolveDLQ(questionId, resolvedBy, note);
    res.json(ok({ questionId, resolvedBy, note }));
  } catch (err) {
    res.status(500).json(fail('DLQ_RESOLVE_FAILED', err instanceof Error ? err.message : String(err)));
  }
});

// ─── POST /api/exams/admin/dlq/:questionId/force-add ─────────────────────────
// Manually add a question to the DLQ (admin override for investigation).
router.post('/admin/dlq/:questionId/force-add', requireAuth, requireAdmin, async (req, res) => {
  try {
    const questionId = str(req.params.questionId);
    const pool       = getSharedPool();

    const { rows } = await pool.query<{ exam_id: string; attempt_count: number }>(
      `SELECT q.exam_id,
              COALESCE(ca.attempt_count, 0) AS attempt_count
       FROM public.exam_questions q
       LEFT JOIN public.exam_canonical_answers ca ON ca.question_id = q.id
       WHERE q.id = $1 LIMIT 1`,
      [questionId],
    );
    if (!rows[0]) { res.status(404).json(fail('NOT_FOUND', 'Question not found')); return; }

    await insertDLQ({
      questionId,
      examId:       rows[0].exam_id,
      attemptCount: rows[0].attempt_count,
      lastError:    'Manually added by admin',
    });
    res.json(ok({ questionId, examId: rows[0].exam_id }));
  } catch (err) {
    res.status(500).json(fail('DLQ_FORCE_ADD_FAILED', err instanceof Error ? err.message : String(err)));
  }
});

export default router;
