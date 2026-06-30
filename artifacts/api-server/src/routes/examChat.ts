/**
 * Exam Chat Context API
 *
 * GET /api/exams/chat-context
 *   Query: country, subject
 *   Auth: requireAuth
 *
 * Returns weakness-targeted exam questions for the Socratic Tutor (EXAM_MODE).
 *
 * Design notes:
 *   - Visibility bypass (isAdmin:true): chat context is educational access for all
 *     students — the admin uploads exams for the platform, not just themselves.
 *   - Grade NOT used as filter: frontend sends level format ('secondary') but DB
 *     stores grade format ('grade12'). Subject + country uniquely identifies the
 *     relevant pool. Grade mapping can be added later when needed.
 *   - Questions sorted: weakest topics first, shuffled others after.
 */
import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
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
    const subject   = str(req.query.subject);
    const studentId = req.user!.uid;

    // 1. Fetch all questions for this subject — bypass visibility (educational access)
    //    Grade filter omitted: frontend level format != DB grade format.
    const [allQuestions, snapshot] = await Promise.all([
      examStore.searchQuestions({
        country: country || undefined,
        subject: subject || undefined,
        userId:  studentId,
        isAdmin: true,           // Bypass private/public gate for chat educational use
      }),
      subject
        ? examSolverStore.listWeaknessSnapshots(studentId)
        : Promise.resolve([]),
    ]);

    // 2. Find the most relevant weakness snapshot (matching country + subject)
    const snapshots = Array.isArray(snapshot) ? snapshot : [];
    const relevantSnapshot = snapshots.find(
      s => s.subject === subject && (!country || s.country === country)
    ) ?? null;

    const topicScores = (relevantSnapshot?.topicScores ?? {}) as Record<string, TopicEntry>;
    const hasWeaknessData = Object.keys(topicScores).length > 0;

    // 3. Sort topics ascending by score (lowest score = weakest)
    const weakTopics: string[] = (Object.entries(topicScores) as [string, TopicEntry][])
      .filter(([, v]) => v.total > 0)
      .sort(([, a], [, b]) => a.score - b.score)
      .map(([topic]) => topic);

    const weakTopicSet = new Set(weakTopics.slice(0, 6));

    // 4. Partition: weak-topic questions first, others after
    type AnyQ = { topic?: string | null };
    const weakQuestions  = allQuestions.filter((q: AnyQ) => q.topic && weakTopicSet.has(q.topic));
    const otherQuestions = allQuestions.filter((q: AnyQ) => !q.topic || !weakTopicSet.has(q.topic));

    const shuffle = <T>(arr: T[]): T[] =>
      arr.map(v => ({ v, r: Math.random() }))
         .sort((a, b) => a.r - b.r)
         .map(({ v }) => v);

    const questions = [
      ...shuffle(weakQuestions).slice(0, 10),
      ...shuffle(otherQuestions).slice(0, 5),
    ].slice(0, 15);

    res.json({
      weakTopics,
      questions,
      hasWeaknessData,
      totalInBank: allQuestions.length,   // Let frontend know how many exist
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
