import { pgTable, text, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import { z } from 'zod/v4';
import { sql } from 'drizzle-orm';
import { examAttemptsTable } from './exam_attempts';
import { examQuestionsTable } from './exam_questions';

export const examAnswersTable = pgTable(
  'exam_answers',
  {
    id:             text('id').primaryKey(),
    attemptId:      text('attempt_id').notNull().references(
                      () => examAttemptsTable.id, { onDelete: 'cascade' }
                    ),
    questionId:     text('question_id').notNull().references(
                      () => examQuestionsTable.id
                    ),
    studentAnswer:  text('student_answer'),
    isCorrect:      boolean('is_correct'),
    gradingMethod:  text('grading_method').default('pending'),
    aiFeedback:     text('ai_feedback'),
    answeredAt:     timestamp('answered_at', { withTimezone: true }).default(sql`NOW()`).notNull(),
  },
  (t) => [
    index('exam_answers_attempt_idx').on(t.attemptId),
    index('exam_answers_question_idx').on(t.questionId),
  ]
);

export const insertExamAnswerSchema = createInsertSchema(examAnswersTable);
export const selectExamAnswerSchema = createSelectSchema(examAnswersTable);
export type ExamAnswer       = typeof examAnswersTable.$inferSelect;
export type InsertExamAnswer = z.infer<typeof insertExamAnswerSchema>;
