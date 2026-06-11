import { pgTable, text, integer, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import { z } from 'zod/v4';
import { sql } from 'drizzle-orm';
import { examRecordsTable } from './exam_records';

export const examQuestionsTable = pgTable(
  'exam_questions',
  {
    id:               text('id').primaryKey(),
    examId:           text('exam_id').notNull().references(
                        () => examRecordsTable.examId, { onDelete: 'cascade' }
                      ),
    question:         text('question').notNull(),
    questionType:     text('question_type').notNull().default('mcq'),
    options:          jsonb('options'),
    correctAnswer:    text('correct_answer'),
    explanation:      text('explanation'),
    topic:            text('topic'),
    chapter:          text('chapter'),
    subject:          text('subject').notNull(),
    grade:            text('grade').notNull(),
    country:          text('country').notNull(),
    year:             text('year'),
    examType:         text('exam_type'),
    difficulty:       text('difficulty'),
    organization:     text('organization'),
    sourceExamId:     text('source_exam_id').notNull(),
    sourceExamTitle:  text('source_exam_title').notNull(),
    questionOrder:    integer('question_order'),
    extractedAt:      timestamp('extracted_at', { withTimezone: true }).default(sql`NOW()`),
  },
  (t) => [
    index('exam_questions_exam_idx').on(t.examId),
    index('exam_questions_type_idx').on(t.examId, t.questionType),
    index('exam_questions_search_idx').on(t.country, t.grade, t.subject, t.questionOrder),
  ]
);

export const insertExamQuestionSchema = createInsertSchema(examQuestionsTable);
export const selectExamQuestionSchema = createSelectSchema(examQuestionsTable);
export type ExamQuestion      = typeof examQuestionsTable.$inferSelect;
export type InsertExamQuestion = z.infer<typeof insertExamQuestionSchema>;
