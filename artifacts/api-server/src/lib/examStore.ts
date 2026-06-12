/**
 * IExamQuestionStore — interface + PostgresExamQuestionStore implementation.
 *
 * Architecture rule: NO route or business-logic file may import from
 * @workspace/db directly. All exam DB access goes through this module only.
 */
import { v4 as uuidv4 } from 'uuid';
import {
  db,
  examRecordsTable,
  examQuestionsTable,
  type ExamRecord,
  type InsertExamRecord,
  type ExamQuestion,
  type InsertExamQuestion,
} from '@workspace/db';
import { eq, and, or, sql } from 'drizzle-orm';

// ─── Interface ────────────────────────────────────────────────────────────────

export interface IExamQuestionStore {
  // ── ExamRecord ──────────────────────────────────────────────────────────────
  upsertExamRecord(record: InsertExamRecord): Promise<void>;
  getExamRecord(examId: string): Promise<ExamRecord | null>;
  listExamRecords(opts: { userId: string; isAdmin: boolean }): Promise<ExamRecord[]>;
  deleteExamRecord(examId: string): Promise<void>;

  // ── ExamQuestion ────────────────────────────────────────────────────────────
  saveQuestions(questions: InsertExamQuestion[]): Promise<void>;
  getQuestionById(id: string): Promise<ExamQuestion | null>;
  getQuestionsByIds(ids: string[]): Promise<ExamQuestion[]>;
  getQuestionsByExam(examId: string): Promise<ExamQuestion[]>;
  searchQuestions(opts: {
    country?: string;
    grade?: string;
    subject?: string;
    userId: string;
    isAdmin: boolean;
  }): Promise<ExamQuestion[]>;
  deleteQuestionsByExam(examId: string): Promise<void>;
  deleteQuestionById(id: string): Promise<void>;
  hasQuestions(examId: string): Promise<boolean>;
}

// ─── PostgreSQL implementation ────────────────────────────────────────────────

class PostgresExamQuestionStore implements IExamQuestionStore {
  // ── ExamRecord ──────────────────────────────────────────────────────────────

  async upsertExamRecord(record: InsertExamRecord): Promise<void> {
    await db
      .insert(examRecordsTable)
      .values(record)
      .onConflictDoUpdate({
        target: examRecordsTable.examId,
        set: {
          extractionStatus: record.extractionStatus ?? 'pending',
          extractionError:  record.extractionError  ?? null,
          extractedAt:      record.extractedAt      ?? null,
          questionCount:    record.questionCount     ?? 0,
          updatedAt:        sql`NOW()`,
        },
      });
  }

  async getExamRecord(examId: string): Promise<ExamRecord | null> {
    const rows = await db
      .select()
      .from(examRecordsTable)
      .where(eq(examRecordsTable.examId, examId))
      .limit(1);
    return rows[0] ?? null;
  }

  async listExamRecords({ userId, isAdmin }: { userId: string; isAdmin: boolean }): Promise<ExamRecord[]> {
    if (isAdmin) {
      return db.select().from(examRecordsTable);
    }
    return db
      .select()
      .from(examRecordsTable)
      .where(
        or(
          eq(examRecordsTable.visibility, 'public'),
          and(
            eq(examRecordsTable.visibility, 'private'),
            eq(examRecordsTable.ownerId, userId)
          )
        )
      );
  }

  async deleteExamRecord(examId: string): Promise<void> {
    // exam_questions are deleted via ON DELETE CASCADE
    await db.delete(examRecordsTable).where(eq(examRecordsTable.examId, examId));
  }

  // ── ExamQuestion ────────────────────────────────────────────────────────────

  async saveQuestions(questions: InsertExamQuestion[]): Promise<void> {
    if (questions.length === 0) return;
    const CHUNK = 100;
    for (let i = 0; i < questions.length; i += CHUNK) {
      await db.insert(examQuestionsTable).values(questions.slice(i, i + CHUNK));
    }
  }

  async getQuestionById(id: string): Promise<ExamQuestion | null> {
    const rows = await db
      .select()
      .from(examQuestionsTable)
      .where(eq(examQuestionsTable.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async getQuestionsByIds(ids: string[]): Promise<ExamQuestion[]> {
    if (ids.length === 0) return [];
    const { inArray } = await import('drizzle-orm');
    return db.select().from(examQuestionsTable).where(inArray(examQuestionsTable.id, ids));
  }

  async getQuestionsByExam(examId: string): Promise<ExamQuestion[]> {
    return db
      .select()
      .from(examQuestionsTable)
      .where(eq(examQuestionsTable.examId, examId))
      .orderBy(examQuestionsTable.questionOrder);
  }

  async searchQuestions({
    country,
    grade,
    subject,
    userId,
    isAdmin,
  }: {
    country?: string;
    grade?: string;
    subject?: string;
    userId: string;
    isAdmin: boolean;
  }): Promise<ExamQuestion[]> {
    // JOIN with exam_records to enforce visibility gate.
    // Build conditions dynamically so all filter params are optional.
    type Condition = Parameters<typeof and>[0];
    const conditions: Condition[] = [];

    if (country) conditions.push(eq(examQuestionsTable.country, country));
    if (grade)   conditions.push(eq(examQuestionsTable.grade,   grade));
    if (subject) conditions.push(eq(examQuestionsTable.subject, subject));

    if (!isAdmin) {
      conditions.push(
        or(
          eq(examRecordsTable.visibility, 'public'),
          and(
            eq(examRecordsTable.visibility, 'private'),
            eq(examRecordsTable.ownerId, userId)
          )
        )
      );
    }

    const rows = await db
      .select({ q: examQuestionsTable })
      .from(examQuestionsTable)
      .innerJoin(
        examRecordsTable,
        eq(examQuestionsTable.sourceExamId, examRecordsTable.examId)
      )
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(examQuestionsTable.questionOrder);

    return rows.map((r) => r.q);
  }

  async deleteQuestionsByExam(examId: string): Promise<void> {
    await db.delete(examQuestionsTable).where(eq(examQuestionsTable.examId, examId));
  }

  async deleteQuestionById(id: string): Promise<void> {
    await db.delete(examQuestionsTable).where(eq(examQuestionsTable.id, id));
  }

  async hasQuestions(examId: string): Promise<boolean> {
    const rows = await db
      .select({ id: examQuestionsTable.id })
      .from(examQuestionsTable)
      .where(eq(examQuestionsTable.examId, examId))
      .limit(1);
    return rows.length > 0;
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

export const examStore: IExamQuestionStore = new PostgresExamQuestionStore();

// ─── Helper: build examId from docId (stable, idempotent) ────────────────────

export function examIdFromDocId(docId: string): string {
  return docId;
}
