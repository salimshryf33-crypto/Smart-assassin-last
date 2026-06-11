/**
 * IExamSolverStore — interface + PostgresExamSolverStore.
 *
 * Covers: exam_attempts, exam_answers, weakness_snapshots.
 * Architecture rule: no other file may import from @workspace/db directly
 * for solver/grading/weakness data — go through this store only.
 */
import {
  db,
  examAttemptsTable,
  examAnswersTable,
  weaknessSnapshotsTable,
  type ExamAttempt,
  type InsertExamAttempt,
  type ExamAnswer,
  type InsertExamAnswer,
  type WeaknessSnapshot,
  type TopicScoreMap,
} from '@workspace/db';
import { eq, and, sql } from 'drizzle-orm';

// ─── Interface ────────────────────────────────────────────────────────────────

export interface IExamSolverStore {
  // ── Attempts ────────────────────────────────────────────────────────────────
  createAttempt(attempt: InsertExamAttempt): Promise<ExamAttempt>;
  getAttempt(attemptId: string): Promise<ExamAttempt | null>;
  listAttemptsByStudent(studentId: string, examId?: string): Promise<ExamAttempt[]>;
  updateAttempt(attemptId: string, patch: Partial<ExamAttempt>): Promise<void>;

  // ── Answers ─────────────────────────────────────────────────────────────────
  saveAnswer(answer: InsertExamAnswer): Promise<ExamAnswer>;
  upsertAnswer(answer: InsertExamAnswer): Promise<void>;
  getAnswersByAttempt(attemptId: string): Promise<ExamAnswer[]>;
  updateAnswer(answerId: string, patch: Partial<ExamAnswer>): Promise<void>;

  // ── Weakness Snapshots ──────────────────────────────────────────────────────
  getWeaknessSnapshot(studentId: string, country: string, grade: string, subject: string): Promise<WeaknessSnapshot | null>;
  upsertWeaknessSnapshot(
    studentId: string,
    country: string,
    grade: string,
    subject: string,
    topicScores: TopicScoreMap,
    totalExams: number
  ): Promise<void>;
  listWeaknessSnapshots(studentId: string): Promise<WeaknessSnapshot[]>;
}

// ─── PostgreSQL implementation ────────────────────────────────────────────────

class PostgresExamSolverStore implements IExamSolverStore {
  // ── Attempts ────────────────────────────────────────────────────────────────

  async createAttempt(attempt: InsertExamAttempt): Promise<ExamAttempt> {
    const rows = await db.insert(examAttemptsTable).values(attempt).returning();
    return rows[0]!;
  }

  async getAttempt(attemptId: string): Promise<ExamAttempt | null> {
    const rows = await db
      .select()
      .from(examAttemptsTable)
      .where(eq(examAttemptsTable.id, attemptId))
      .limit(1);
    return rows[0] ?? null;
  }

  async listAttemptsByStudent(studentId: string, examId?: string): Promise<ExamAttempt[]> {
    const filter = examId
      ? and(eq(examAttemptsTable.studentId, studentId), eq(examAttemptsTable.examId, examId))
      : eq(examAttemptsTable.studentId, studentId);
    return db.select().from(examAttemptsTable).where(filter);
  }

  async updateAttempt(attemptId: string, patch: Partial<ExamAttempt>): Promise<void> {
    await db
      .update(examAttemptsTable)
      .set(patch)
      .where(eq(examAttemptsTable.id, attemptId));
  }

  // ── Answers ─────────────────────────────────────────────────────────────────

  async saveAnswer(answer: InsertExamAnswer): Promise<ExamAnswer> {
    const rows = await db.insert(examAnswersTable).values(answer).returning();
    return rows[0]!;
  }

  async upsertAnswer(answer: InsertExamAnswer): Promise<void> {
    await db
      .insert(examAnswersTable)
      .values(answer)
      .onConflictDoUpdate({
        target: examAnswersTable.id,
        set: {
          studentAnswer: answer.studentAnswer,
          isCorrect:     answer.isCorrect,
          gradingMethod: answer.gradingMethod,
          aiFeedback:    answer.aiFeedback,
          answeredAt:    sql`NOW()`,
        },
      });
  }

  async getAnswersByAttempt(attemptId: string): Promise<ExamAnswer[]> {
    return db
      .select()
      .from(examAnswersTable)
      .where(eq(examAnswersTable.attemptId, attemptId));
  }

  async updateAnswer(answerId: string, patch: Partial<ExamAnswer>): Promise<void> {
    await db
      .update(examAnswersTable)
      .set(patch)
      .where(eq(examAnswersTable.id, answerId));
  }

  // ── Weakness Snapshots ──────────────────────────────────────────────────────

  async getWeaknessSnapshot(
    studentId: string,
    country: string,
    grade: string,
    subject: string
  ): Promise<WeaknessSnapshot | null> {
    const rows = await db
      .select()
      .from(weaknessSnapshotsTable)
      .where(
        and(
          eq(weaknessSnapshotsTable.studentId, studentId),
          eq(weaknessSnapshotsTable.country, country),
          eq(weaknessSnapshotsTable.grade, grade),
          eq(weaknessSnapshotsTable.subject, subject)
        )
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async upsertWeaknessSnapshot(
    studentId: string,
    country: string,
    grade: string,
    subject: string,
    topicScores: TopicScoreMap,
    totalExams: number
  ): Promise<void> {
    await db
      .insert(weaknessSnapshotsTable)
      .values({ studentId, country, grade, subject, topicScores, totalExams })
      .onConflictDoUpdate({
        target: [
          weaknessSnapshotsTable.studentId,
          weaknessSnapshotsTable.country,
          weaknessSnapshotsTable.grade,
          weaknessSnapshotsTable.subject,
        ],
        set: {
          topicScores,
          totalExams,
          lastUpdated: sql`NOW()`,
        },
      });
  }

  async listWeaknessSnapshots(studentId: string): Promise<WeaknessSnapshot[]> {
    return db
      .select()
      .from(weaknessSnapshotsTable)
      .where(eq(weaknessSnapshotsTable.studentId, studentId));
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

export const examSolverStore: IExamSolverStore = new PostgresExamSolverStore();
