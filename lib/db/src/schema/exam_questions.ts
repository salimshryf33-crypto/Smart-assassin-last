import { pgTable, serial, text, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import { z } from 'zod/v4';
import { sql } from 'drizzle-orm';

export const examQuestionsTable = pgTable(
  'exam_questions',
  {
    id:           serial('id').primaryKey(),
    docId:        text('doc_id').notNull(),
    ownerId:      text('owner_id'),             // null = public (admin-uploaded exam)
    visibility:   text('visibility').notNull().default('private'), // 'public' | 'private'
    country:      text('country').notNull(),
    grade:        text('grade').notNull(),
    subject:      text('subject').notNull(),
    track:        text('track').notNull().default(''),
    questionText: text('question_text').notNull(),
    options:      jsonb('options'),             // string[] for MCQ, null for open
    answer:       text('answer'),               // correct answer text
    questionType: text('question_type').notNull().default('mcq'), // 'mcq' | 'short_answer' | 'essay'
    sourcePageRange: text('source_page_range'), // e.g. "12-14"
    createdAt:    timestamp('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  },
  (t) => [
    index('eq_doc_id_idx').on(t.docId),
    index('eq_owner_idx').on(t.ownerId),
    index('eq_subject_idx').on(t.country, t.grade, t.subject),
  ]
);

export const insertExamQuestionSchema = createInsertSchema(examQuestionsTable).omit({
  id: true,
  createdAt: true,
});

export const selectExamQuestionSchema = createSelectSchema(examQuestionsTable);

export type ExamQuestion    = typeof examQuestionsTable.$inferSelect;
export type InsertExamQuestion = z.infer<typeof insertExamQuestionSchema>;
