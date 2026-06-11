/**
 * Exam Generator routes — AI-powered exam generation from curriculum.
 *
 * POST /api/exams/generate  — generate a new exam from curriculum chunks
 */
import { Router } from 'express';
import { generateExam } from '../lib/examGenerator';
import { requireAuth, requireAdmin, isAdmin } from '../middleware/auth';

const router = Router();

// ─── POST /api/exams/generate ─────────────────────────────────────────────────
// Admin → generates a public exam.
// Any user → generates a private practice exam for themselves.
router.post('/generate', requireAuth, async (req, res) => {
  const {
    country,
    grade,
    subject,
    track        = '',
    chapter      = '',
    topic        = '',
    year,
    examType     = 'practice',
    organization = '',
    count        = 10,
    title        = '',
    bookTitle    = '',
    typeBreakdown,
  } = req.body as Record<string, unknown>;

  if (!country || !grade || !subject) {
    res.status(400).json({ error: 'country, grade, and subject are required' });
    return;
  }

  const caller   = req.user!;
  const adminCaller = isAdmin(caller);
  const visibility: 'public' | 'private' = adminCaller ? 'public' : 'private';
  const ownerId = adminCaller ? null : caller.uid;
  const safeCount = Math.min(Math.max(1, Number(count) || 10), 30);

  try {
    const result = await generateExam({
      country:      String(country),
      grade:        String(grade),
      subject:      String(subject),
      track:        String(track),
      chapter:      chapter ? String(chapter) : undefined,
      topic:        topic   ? String(topic)   : undefined,
      year:         year    ? String(year)    : undefined,
      examType:     String(examType),
      organization: organization ? String(organization) : undefined,
      count:        safeCount,
      title:        title    ? String(title)    : undefined,
      bookTitle:    bookTitle ? String(bookTitle) : undefined,
      ownerId,
      visibility,
      typeBreakdown: typeBreakdown as Record<string, number> | undefined,
    });

    req.log.info(
      { examId: result.examId, questionCount: result.questionCount, visibility },
      'Exam generated'
    );
    res.status(201).json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

export default router;
