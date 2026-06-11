/**
 * Exam Bank API routes
 *
 * GET    /api/exams/records              — list exam records visible to caller
 * GET    /api/exams/records/:examId      — single exam record
 * DELETE /api/exams/records/:examId      — delete exam record + questions (admin or owner)
 * GET    /api/exams/records/:examId/questions — list questions for an exam
 * GET    /api/exams/questions            — search questions by country/grade/subject
 * DELETE /api/exams/questions/:id        — delete a single question (admin or owner)
 * POST   /api/exams/records/:examId/retry — retry extraction for error/pending record (admin)
 */
import { Router } from 'express';
import { examStore } from '../lib/examStore';
import { triggerQuestionExtraction } from '../lib/questionExtractor';
import { requireAuth, requireAdmin, isAdmin } from '../middleware/auth';

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
// Query params: country, grade, subject (required)
router.get('/questions', requireAuth, async (req, res) => {
  const { country, grade, subject } = req.query as Record<string, string>;
  if (!country || !grade || !subject) {
    res.status(400).json({ error: 'country, grade, and subject are required' });
    return;
  }
  try {
    const questions = await examStore.searchQuestions({
      country, grade, subject,
      userId:  req.user!.uid,
      isAdmin: isAdmin(req.user!),
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

export default router;
