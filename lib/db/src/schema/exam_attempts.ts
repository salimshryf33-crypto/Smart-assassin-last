import { pgTable, text, integer, numeric, timestamp, index } from 'drizzle-orm/pg-core';
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import { z } from 'zod/v4';
import { sql } from 'drizzle-orm';
import { examRecordsTable } from './exam_records';

export const examAttemptsTable = pgTable(
  'exam_attempts',
  {
    id:              text('id').primaryKey(),
    examId:          text('exam_id').notNull().references(
                       () => examRecordsTable.examId, { onDelete: 'cascade' }
                     ),
    studentId:       text('student_id').notNull(),
    status:          text('status').notNull().default('in_progress'),
    totalQuestions:  integer('total_questions').default(0),
    correctCount:    integer('correct_count').default(0),
    scorePct:        numeric('score_pct', { precision: 5, scale: 2 }),
    startedAt:       timestamp('started_at', { withTimezone: true }).default(sql`NOW()`).notNull(),
    completedAt:     timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    index('exam_attempts_exam_idx').on(t.examId),
    index('exam_attempts_student_idx').on(t.studentId),
    index('exam_attempts_status_idx').on(t.studentId, t.status),
  ]
);

export const insertExamAttemptSchema = createInsertSchema(examAttemptsTable);
export const selectExamAttemptSchema = createSelectSchema(examAttemptsTable);
export type ExamAttempt       = typeof examAttemptsTable.$inferSelect;
export type InsertExamAttempt = z.infer<typeof insertExamAttemptSchema>;
