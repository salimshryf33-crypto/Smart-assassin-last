/**
 * Exam Solver routes — attempt lifecycle, auto-grading, flashcard bridge,
 * and weakness profile endpoints.
 *
 * Mounted at /api/exams/solve
 *
 * POST   /api/exams/solve/start                        — begin attempt
 * POST   /api/exams/solve/:attemptId/answer            — submit one answer
 * POST   /api/exams/solve/:attemptId/submit            — finalize + grade
 * GET    /api/exams/solve/:attemptId                   — get attempt + answers
 * GET    /api/exams/solve/:attemptId/results           — graded results with Q text
 * GET    /api/exams/solve/:attemptId/flashcards        — wrong answers as flashcard data
 * GET    /api/exams/solve/weakness/list                — student weakness snapshots
 * GET    /api/exams/solve/weakness/topics              — ranked weak topics
 */
import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { examSolverStore } from '../lib/examSolverStore';
import { examStore } from '../lib/examStore';
import { gradeAttempt } from '../lib/autoGrader';
import { updateWeaknessFromAttempt, getStudentWeakTopics } from '../lib/weaknessAnalyzer';
import { requireAuth, isAdmin } from '../middleware/auth';
import * as cache from '../services/cacheService';
import { audit } from '../lib/auditLog';

const router = Router();
const str = (v: string | string[] | undefined): string =>
  Array.isArray(v) ? (v[0] ?? '') : (v ?? '');

// ─── POST /start ──────────────────────────────────────────────────────────────
router.post('/start', requireAuth, async (req, res) => {
  const { examId } = req.body as { examId?: string };
  if (!examId) { res.status(400).json({ error: 'examId required' }); return; }

  const record = await examStore.getExamRecord(examId).catch(() => null);
  if (!record) { res.status(404).json({ error: 'Exam not found' }); return; }

  const uid = req.user!.uid;
  if (record.visibility === 'private' && record.ownerId !== uid && !isAdmin(req.user!)) {
    res.status(403).json({ error: 'Access denied' });
    return;
  }

  try {
    const attempt = await examSolverStore.createAttempt({
      id:             uuidv4(),
      examId,
      studentId:      uid,
      status:         'in_progress',
      totalQuestions: record.questionCount ?? 0,
      correctCount:   0,
      scorePct:       null,
      startedAt:      new Date(),
      completedAt:    null,
    });

    audit({
      uid:          uid,
      action:       'exam_solve_start',
      resourceType: 'exam_attempt',
      resourceId:   attempt.id,
      metadata:     { examId },
      req,
    });

    const questions = await examStore.getQuestionsByExam(examId);
    res.status(201).json({
      attemptId: attempt.id,
      examId,
      questions: questions.map((q) => ({
        id:            q.id,
        question:      q.question,
        questionType:  q.questionType,
        options:       q.options,
        topic:         q.topic,
        chapter:       q.chapter,
        difficulty:    q.difficulty,
        questionOrder: q.questionOrder,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ─── GET /weakness/list ───────────────────────────────────────────────────────
// Must come before /:attemptId to avoid param conflict
router.get('/weakness/list', requireAuth, async (req, res) => {
  const uid      = req.user!.uid;
  const cacheKey = cache.weaknessListKey(uid);
  const cached   = await cache.get<unknown>(cacheKey);
  if (cached !== null) { res.setHeader('X-Cache', 'HIT'); res.json(cached); return; }

  try {
    const snapshots = await examSolverStore.listWeaknessSnapshots(uid);
    const result = { snapshots };
    cache.set(cacheKey, result, cache.TTL.DASHBOARD).catch(() => undefined);
    res.setHeader('X-Cache', 'MISS');
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ─── GET /weakness/topics ─────────────────────────────────────────────────────
router.get('/weakness/topics', requireAuth, async (req, res) => {
  const country = str(req.query.country as string | undefined);
  const grade   = str(req.query.grade as string | undefined);
  if (!country || !grade) {
    res.status(400).json({ error: 'country and grade query params required' });
    return;
  }
  const uid      = req.user!.uid;
  const cacheKey = cache.weaknessTopicsKey(uid, country, grade);
  const cached   = await cache.get<unknown>(cacheKey);
  if (cached !== null) { res.setHeader('X-Cache', 'HIT'); res.json(cached); return; }

  try {
    const topics = await getStudentWeakTopics(uid, country, grade);
    const result = { topics };
    cache.set(cacheKey, result, cache.TTL.DASHBOARD).catch(() => undefined);
    res.setHeader('X-Cache', 'MISS');
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ─── GET /attempts ────────────────────────────────────────────────────────────
// Must come before /:attemptId to avoid param conflict
router.get('/attempts', requireAuth, async (req, res) => {
  try {
    const attempts = await examSolverStore.listAttemptsByStudent(req.user!.uid);
    const examIds = [...new Set(attempts.map((a) => a.examId))];
    const examMap: Record<string, string> = {};
    await Promise.all(
      examIds.map(async (id) => {
        const rec = await examStore.getExamRecord(id).catch(() => null);
        if (rec) examMap[id] = rec.title;
      })
    );
    const enriched = attempts.map((a) => ({
      ...a,
      examTitle: examMap[a.examId] ?? 'امتحان',
    }));
    res.json({ attempts: enriched });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ─── POST /:attemptId/answer ──────────────────────────────────────────────────
router.post('/:attemptId/answer', requireAuth, async (req, res) => {
  const attemptId = str(req.params.attemptId);
  const { questionId, answer } = req.body as { questionId?: string; answer?: string };
  if (!questionId) { res.status(400).json({ error: 'questionId required' }); return; }

  const attempt = await examSolverStore.getAttempt(attemptId).catch(() => null);
  if (!attempt) { res.status(404).json({ error: 'Attempt not found' }); return; }
  if (attempt.studentId !== req.user!.uid) { res.status(403).json({ error: 'Access denied' }); return; }
  if (attempt.status !== 'in_progress') { res.status(409).json({ error: 'Attempt already completed' }); return; }

  try {
    await examSolverStore.upsertAnswer({
      id:             uuidv4(),
      attemptId,
      questionId,
      studentAnswer:  answer ?? null,
      isCorrect:      null,
      gradingMethod:  'pending',
      aiFeedback:     null,
      answeredAt:     new Date(),
    });
    res.json({ saved: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ─── POST /:attemptId/submit ──────────────────────────────────────────────────
router.post('/:attemptId/submit', requireAuth, async (req, res) => {
  const attemptId = str(req.params.attemptId);

  const attempt = await examSolverStore.getAttempt(attemptId).catch(() => null);
  if (!attempt) { res.status(404).json({ error: 'Attempt not found' }); return; }
  if (attempt.studentId !== req.user!.uid) { res.status(403).json({ error: 'Access denied' }); return; }
  if (attempt.status === 'completed') { res.status(409).json({ error: 'Attempt already submitted' }); return; }

  try {
    const result = await gradeAttempt(attemptId);
    updateWeaknessFromAttempt(attemptId, req.user!.uid).catch(() => undefined);

    audit({
      uid:          req.user!.uid,
      action:       'exam_solve_complete',
      resourceType: 'exam_attempt',
      resourceId:   attemptId,
      metadata:     {
        examId:         attempt.examId,
        totalQuestions: result.totalQuestions,
        correctCount:   result.correctCount,
        scorePct:       result.scorePct,
      },
      req,
    });

    res.json({
      attemptId,
      totalQuestions: result.totalQuestions,
      correctCount:   result.correctCount,
      scorePct:       result.scorePct,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ─── GET /:attemptId ─────────────────────────────────────────────────────────
router.get('/:attemptId', requireAuth, async (req, res) => {
  const attemptId = str(req.params.attemptId);
  const attempt   = await examSolverStore.getAttempt(attemptId).catch(() => null);
  if (!attempt) { res.status(404).json({ error: 'Attempt not found' }); return; }
  if (attempt.studentId !== req.user!.uid && !isAdmin(req.user!)) {
    res.status(403).json({ error: 'Access denied' });
    return;
  }
  const answers = await examSolverStore.getAnswersByAttempt(attemptId);
  res.json({ attempt, answers });
});

// ─── GET /:attemptId/results ──────────────────────────────────────────────────
router.get('/:attemptId/results', requireAuth, async (req, res) => {
  const attemptId = str(req.params.attemptId);
  const attempt   = await examSolverStore.getAttempt(attemptId).catch(() => null);
  if (!attempt) { res.status(404).json({ error: 'Attempt not found' }); return; }
  if (attempt.studentId !== req.user!.uid && !isAdmin(req.user!)) {
    res.status(403).json({ error: 'Access denied' });
    return;
  }
  if (attempt.status !== 'completed') {
    res.status(400).json({ error: 'Attempt not yet graded. Submit first.' });
    return;
  }

  const answers   = await examSolverStore.getAnswersByAttempt(attemptId);
  const qIds      = [...new Set(answers.map((a) => a.questionId))];
  const questions = await examStore.getQuestionsByIds(qIds);
  const qMap      = Object.fromEntries(questions.map((q) => [q.id, q]));

  const enriched = answers.map((a) => ({
    ...a,
    questionText:  qMap[a.questionId]?.question      ?? null,
    correctAnswer: qMap[a.questionId]?.correctAnswer ?? null,
    explanation:   qMap[a.questionId]?.explanation   ?? null,
    topic:         qMap[a.questionId]?.topic         ?? null,
    chapter:       qMap[a.questionId]?.chapter       ?? null,
    questionType:  qMap[a.questionId]?.questionType  ?? null,
    options:       qMap[a.questionId]?.options       ?? null,
  }));

  res.json({
    attemptId,
    examId:         attempt.examId,
    studentId:      attempt.studentId,
    totalQuestions: attempt.totalQuestions,
    correctCount:   attempt.correctCount,
    scorePct:       attempt.scorePct,
    completedAt:    attempt.completedAt,
    answers:        enriched,
  });
});

// ─── GET /:attemptId/flashcards ───────────────────────────────────────────────
router.get('/:attemptId/flashcards', requireAuth, async (req, res) => {
  const attemptId = str(req.params.attemptId);
  const attempt   = await examSolverStore.getAttempt(attemptId).catch(() => null);
  if (!attempt) { res.status(404).json({ error: 'Attempt not found' }); return; }
  if (attempt.studentId !== req.user!.uid && !isAdmin(req.user!)) {
    res.status(403).json({ error: 'Access denied' });
    return;
  }

  const answers = await examSolverStore.getAnswersByAttempt(attemptId);
  const wrong   = answers.filter((a) => a.isCorrect === false);
  if (wrong.length === 0) { res.json({ flashcards: [], count: 0 }); return; }

  const qIds      = wrong.map((a) => a.questionId);
  const questions = await examStore.getQuestionsByIds(qIds);
  const qMap      = Object.fromEntries(questions.map((q) => [q.id, q]));

  const flashcards = wrong.map((a) => {
    const q = qMap[a.questionId];
    return {
      front:         q?.question      ?? 'سؤال',
      back:          q?.correctAnswer ?? q?.explanation ?? a.aiFeedback ?? 'راجع الشرح',
      category:      q?.topic ?? q?.chapter ?? q?.subject ?? 'عام',
      source:        'exam_question',
      examId:        attempt.examId,
      questionId:    a.questionId,
      studentAnswer: a.studentAnswer,
      aiFeedback:    a.aiFeedback,
    };
  });

  res.json({ flashcards, count: flashcards.length });
});

export default router;
