/**
 * Exam Chat Context API
 *
 * GET /api/exams/chat-context
 *   Query: country, subject
 *   Auth: requireAuth
 *
 * Returns weakness-targeted exam questions for the Socratic Tutor (EXAM_MODE).
 *
 * Visibility model (enforced by searchQuestions):
 *   - public  exams (admin-uploaded) → visible to every authenticated student
 *   - private exams (student-uploaded) → visible to that student only
 *   This is the correct multi-tenant behaviour — no bypass needed here.
 *
 * Grade NOT used as filter: frontend sends level format ('secondary') but DB
 * stores grade format ('grade12'). Subject + country uniquely identifies the
 * relevant pool. Grade mapping can be added when multiple grades are needed.
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
    const subject   = str(req.query.subject);
    const studentId = req.user!.uid;

    // 1. Fetch accessible questions using the standard visibility gate:
    //    - public exams  → all students see them (admin-uploaded platform content)
    //    - private exams → owner sees their own only
    //    Grade filter omitted: level ('secondary') ≠ DB format ('grade12').
    const [allQuestions, snapshots] = await Promise.all([
      examStore.searchQuestions({
        country: country  || undefined,
        subject: subject  || undefined,
        userId:  studentId,
        isAdmin: isAdmin(req.user!),
      }),
      subject
        ? examSolverStore.listWeaknessSnapshots(studentId)
        : Promise.resolve([] as Awaited<ReturnType<typeof examSolverStore.listWeaknessSnapshots>>),
    ]);

    // 2. Find weakness snapshot for this subject+country
    const relevantSnapshot = (Array.isArray(snapshots) ? snapshots : []).find(
      s => s.subject === subject && (!country || s.country === country)
    ) ?? null;

    const topicScores    = (relevantSnapshot?.topicScores ?? {}) as Record<string, TopicEntry>;
    const hasWeaknessData = Object.keys(topicScores).length > 0;

    // 3. Sort topics ascending by score (lowest = weakest)
    const weakTopics: string[] = (Object.entries(topicScores) as [string, TopicEntry][])
      .filter(([, v]) => v.total > 0)
      .sort(([, a], [, b]) => a.score - b.score)
      .map(([topic]) => topic);

    const weakTopicSet = new Set(weakTopics.slice(0, 6));

    // 4. Partition: weak-topic questions first, random others after
    type AnyQ = { topic?: string | null };
    const weakQuestions  = allQuestions.filter((q: AnyQ) =>  q.topic && weakTopicSet.has(q.topic));
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
      totalInBank: allQuestions.length,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
