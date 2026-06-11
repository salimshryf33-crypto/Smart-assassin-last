/**
 * weaknessAnalyzer — computes and persists per-student weakness profiles
 * from exam attempt results.
 *
 * Architecture rule: reads via IExamQuestionStore + IExamSolverStore only.
 */
import { examStore } from './examStore';
import { examSolverStore } from './examSolverStore';
import { logger } from './logger';
import type { TopicScoreMap } from '@workspace/db';

/**
 * After an attempt is graded, update the student's weakness snapshot.
 * Called fire-and-forget from the solver route.
 */
export async function updateWeaknessFromAttempt(
  attemptId: string,
  studentId: string
): Promise<void> {
  try {
    const answers = await examSolverStore.getAnswersByAttempt(attemptId);
    if (answers.length === 0) return;

    // Collect all unique question IDs from graded answers
    const gradedAnswers = answers.filter((a) => a.isCorrect !== null);
    if (gradedAnswers.length === 0) return;

    const qIds = [...new Set(gradedAnswers.map((a) => a.questionId))];
    const questions = await examStore.getQuestionsByIds(qIds);
    const qMap = Object.fromEntries(questions.map((q) => [q.id, q]));

    // Group by (country, grade, subject) → topic → {correct, total}
    type SubjectKey = string;
    const grouped = new Map<SubjectKey, Map<string, { correct: number; total: number }>>();

    for (const answer of gradedAnswers) {
      const q = qMap[answer.questionId];
      if (!q) continue;

      const topic = q.topic ?? q.chapter ?? 'عام';
      const key: SubjectKey = `${q.country}|${q.grade}|${q.subject}`;

      if (!grouped.has(key)) grouped.set(key, new Map());
      const topicMap = grouped.get(key)!;

      if (!topicMap.has(topic)) topicMap.set(topic, { correct: 0, total: 0 });
      const entry = topicMap.get(topic)!;
      entry.total++;
      if (answer.isCorrect) entry.correct++;
    }

    // Persist each (country, grade, subject) snapshot
    for (const [key, topicMap] of grouped.entries()) {
      const [country, grade, subject] = key.split('|') as [string, string, string];

      const existing = await examSolverStore.getWeaknessSnapshot(studentId, country, grade, subject);
      const prevScores = (existing?.topicScores ?? {}) as TopicScoreMap;

      const newScores: TopicScoreMap = { ...prevScores };

      for (const [topic, counts] of topicMap.entries()) {
        const prev = prevScores[topic] ?? { correct: 0, total: 0, score: 0 };
        const merged = {
          correct: prev.correct + counts.correct,
          total:   prev.total   + counts.total,
          score:   0,
        };
        merged.score = merged.total > 0 ? merged.correct / merged.total : 0;
        newScores[topic] = merged;
      }

      const totalExams = (existing?.totalExams ?? 0) + 1;
      await examSolverStore.upsertWeaknessSnapshot(
        studentId, country, grade, subject, newScores, totalExams
      );

      logger.info(
        { studentId, country, grade, subject, topics: Object.keys(newScores).length },
        'weaknessAnalyzer: snapshot updated'
      );
    }
  } catch (err) {
    logger.error({ attemptId, studentId, err: String(err) }, 'weaknessAnalyzer: failed');
  }
}

// ─── Weak topics summary ──────────────────────────────────────────────────────

export interface WeakTopicResult {
  subject:       string;
  topic:         string;
  weaknessScore: number;
  correct:       number;
  total:         number;
}

export async function getStudentWeakTopics(
  studentId: string,
  country: string,
  grade: string,
  minTotal = 2
): Promise<WeakTopicResult[]> {
  const snapshots = await examSolverStore.listWeaknessSnapshots(studentId);
  const relevant  = snapshots.filter(
    (s) => s.country === country && s.grade === grade
  );

  const results: WeakTopicResult[] = [];

  for (const snap of relevant) {
    const scores = (snap.topicScores ?? {}) as TopicScoreMap;
    for (const [topic, ts] of Object.entries(scores)) {
      if (ts.total < minTotal) continue;
      results.push({
        subject:       snap.subject,
        topic,
        weaknessScore: 1 - ts.score,
        correct:       ts.correct,
        total:         ts.total,
      });
    }
  }

  return results.sort((a, b) => b.weaknessScore - a.weaknessScore);
}
