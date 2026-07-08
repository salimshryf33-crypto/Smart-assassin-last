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
} from '../lib/examValidation';

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

export default router;
