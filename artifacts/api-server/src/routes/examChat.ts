/**
 * Exam Chat Context API
 *
 * GET /api/exams/chat-context
 *   Query: country, grade, subject
 *   Auth: requireAuth
 *
 * Returns weakness-targeted exam questions for the Socratic Tutor (EXAM_MODE).
 * Questions are sorted: weakest topics first, then others.
 * Weakness is read from weakness_snapshots for the authenticated student.
 */
import { Router } from 'express';
import { requireAuth, isAdmin } from '../middleware/auth';
import { examStore } from '../lib/examStore';
import { examSolverStore } from '../lib/examSolverStore';
type TopicEntry = { correct: number; total: number; score: number };

const router = Router();

const str = (v: unknown): string =>
  Array.isArray(v) ? String(v[0] ?? '') : String(v ?? '');

// ─── GET /api/exams/chat-context ──────────────────────────────────────────────

router.get('/chat-context', requireAuth, async (req, res) => {
  try {
    const country   = str(req.query.country);
    const grade     = str(req.query.grade);
    const subject   = str(req.query.subject);
    const studentId = req.user!.uid;

    // 1. Fetch all accessible questions for this curriculum in parallel with weakness lookup
    const [allQuestions, snapshot] = await Promise.all([
      examStore.searchQuestions({
        country:  country  || undefined,
        grade:    grade    || undefined,
        subject:  subject  || undefined,
        userId:   studentId,
        isAdmin:  isAdmin(req.user!),
      }),
      (country && grade && subject)
        ? examSolverStore.getWeaknessSnapshot(studentId, country, grade, subject)
        : Promise.resolve(null),
    ]);

    // 2. Extract and rank weak topics (score = correct/total; lower = weaker)
    const topicScores = (snapshot?.topicScores ?? {}) as Record<string, TopicEntry>;
    const hasWeaknessData = Object.keys(topicScores).length > 0;

    // Sort topics ascending by score (lowest score = weakest = worst)
    const weakTopics: string[] = (Object.entries(topicScores) as [string, TopicEntry][])
      .filter(([, v]) => v.total > 0)
      .sort(([, a], [, b]) => a.score - b.score)
      .map(([topic]) => topic);

    const weakTopicSet = new Set(weakTopics.slice(0, 6));

    // 3. Partition questions into: weak-topic questions vs others
    type AnyQ = { topic?: string | null };
    const weakQuestions  = allQuestions.filter((q: AnyQ) => q.topic && weakTopicSet.has(q.topic));
    const otherQuestions = allQuestions.filter((q: AnyQ) => !q.topic || !weakTopicSet.has(q.topic));

    // Shuffle each partition independently
    const shuffle = <T>(arr: T[]): T[] =>
      arr.map(v => ({ v, r: Math.random() }))
         .sort((a, b) => a.r - b.r)
         .map(({ v }) => v);

    // Return up to 15 questions total (10 weak-targeted + 5 others)
    const questions = [
      ...shuffle(weakQuestions).slice(0, 10),
      ...shuffle(otherQuestions).slice(0, 5),
    ].slice(0, 15);

    res.json({ weakTopics, questions, hasWeaknessData });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
