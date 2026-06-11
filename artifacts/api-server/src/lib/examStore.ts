/**
 * IExamQuestionStore — interface + PostgreSQL implementation.
 *
 * Architecture rule: NO route or business-logic file may import from
 * @workspace/db directly. All exam-question DB access goes through this module.
 */
import { db, examQuestionsTable, type ExamQuestion, type InsertExamQuestion } from '@workspace/db';
import { eq, and, or, isNull } from 'drizzle-orm';

// ─── Interface ────────────────────────────────────────────────────────────────

export interface IExamQuestionStore {
  /** Insert a batch of extracted questions for one document. */
  saveQuestions(questions: InsertExamQuestion[]): Promise<void>;

  /** Return all questions for a specific document (owner or admin check upstream). */
  getByDoc(docId: string): Promise<ExamQuestion[]>;

  /**
   * Return questions visible to the given user:
   *  - All public questions matching the filter.
   *  - Private questions owned by `userId`.
   */
  getVisible(opts: {
    country: string;
    grade: string;
    subject: string;
    userId: string;
  }): Promise<ExamQuestion[]>;

  /** Delete all questions belonging to a document. */
  deleteByDoc(docId: string): Promise<void>;

  /** Delete a single question by id. */
  deleteById(id: number): Promise<void>;

  /** Check whether questions have already been extracted for a document. */
  hasQuestions(docId: string): Promise<boolean>;
}

// ─── PostgreSQL implementation ────────────────────────────────────────────────

export const examStore: IExamQuestionStore = {
  async saveQuestions(questions) {
    if (questions.length === 0) return;
    // Insert in chunks of 100 to stay well under parameter limits
    const CHUNK = 100;
    for (let i = 0; i < questions.length; i += CHUNK) {
      await db.insert(examQuestionsTable).values(questions.slice(i, i + CHUNK));
    }
  },

  async getByDoc(docId) {
    return db
      .select()
      .from(examQuestionsTable)
      .where(eq(examQuestionsTable.docId, docId));
  },

  async getVisible({ country, grade, subject, userId }) {
    return db
      .select()
      .from(examQuestionsTable)
      .where(
        and(
          eq(examQuestionsTable.country, country),
          eq(examQuestionsTable.grade, grade),
          eq(examQuestionsTable.subject, subject),
          or(
            eq(examQuestionsTable.visibility, 'public'),
            and(
              eq(examQuestionsTable.visibility, 'private'),
              eq(examQuestionsTable.ownerId, userId)
            )
          )
        )
      );
  },

  async deleteByDoc(docId) {
    await db
      .delete(examQuestionsTable)
      .where(eq(examQuestionsTable.docId, docId));
  },

  async deleteById(id) {
    await db
      .delete(examQuestionsTable)
      .where(eq(examQuestionsTable.id, id));
  },

  async hasQuestions(docId) {
    const rows = await db
      .select({ id: examQuestionsTable.id })
      .from(examQuestionsTable)
      .where(eq(examQuestionsTable.docId, docId))
      .limit(1);
    return rows.length > 0;
  },
};
