import { pgTable, text, integer, timestamp, index } from 'drizzle-orm/pg-core';
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import { z } from 'zod/v4';
import { sql } from 'drizzle-orm';

export const examRecordsTable = pgTable(
  'exam_records',
  {
    examId:            text('exam_id').primaryKey(),
    curriculumDocId:   text('curriculum_doc_id').notNull(),
    title:             text('title').notNull(),
    bookTitle:         text('book_title'),
    subject:           text('subject').notNull(),
    grade:             text('grade').notNull(),
    country:           text('country').notNull(),
    track:             text('track'),
    year:              text('year'),
    examType:          text('exam_type').notNull().default('final'),
    organization:      text('organization'),
    ownerId:           text('owner_id'),
    visibility:        text('visibility').notNull().default('private'),
    questionCount:     integer('question_count').default(0),
    extractionStatus:  text('extraction_status').notNull().default('pending'),
    extractionError:   text('extraction_error'),
    extractedAt:       timestamp('extracted_at', { withTimezone: true }),
    createdAt:         timestamp('created_at', { withTimezone: true }).default(sql`NOW()`).notNull(),
    updatedAt:         timestamp('updated_at', { withTimezone: true }).default(sql`NOW()`).notNull(),
  },
  (t) => [
    index('exam_records_curriculum_idx').on(t.curriculumDocId),
    index('exam_records_owner_idx').on(t.ownerId),
    index('exam_records_status_idx').on(t.extractionStatus),
  ]
);

export const insertExamRecordSchema = createInsertSchema(examRecordsTable);
export const selectExamRecordSchema = createSelectSchema(examRecordsTable);
export type ExamRecord    = typeof examRecordsTable.$inferSelect;
export type InsertExamRecord = z.infer<typeof insertExamRecordSchema>;
