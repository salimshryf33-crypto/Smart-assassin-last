import { pgTable, text, integer, timestamp, index, jsonb } from 'drizzle-orm/pg-core';
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

    // ── Diagnostic columns (nullable — fully backward-compatible) ────────────
    // Written by questionExtractor after each extraction run.
    // All nullable: existing rows and the first upsert that omits them are fine.

    /** Composite OCR quality score 0–100 computed from chunk content. */
    ocrQualityScore:    integer('ocr_quality_score'),

    /** Number of extraction attempts made (chunks processed). */
    extractionAttempts: integer('extraction_attempts'),

    /** Human-readable reason when extraction produces 0 questions. */
    failureReason:      text('failure_reason'),

    /** Full structured diagnostic JSON — pattern counts, scores per chunk, etc. */
    ocrDiagnostics:     jsonb('ocr_diagnostics'),

    /**
     * Phase 2 — Curriculum Linking.
     * Set to the approved curriculum document ID once the Linking System
     * approves a match.  Null = not yet linked (fallback to subject-wide search).
     * Written by curriculumLinker.ts; read by LinkedCurriculumResolver.
     */
    linkedCurriculumDocId: text('linked_curriculum_doc_id'),

    createdAt:         timestamp('created_at', { withTimezone: true }).default(sql`NOW()`).notNull(),
    updatedAt:         timestamp('updated_at', { withTimezone: true }).default(sql`NOW()`).notNull(),
  },
  (t) => [
    index('exam_records_curriculum_idx').on(t.curriculumDocId),
    index('exam_records_owner_idx').on(t.ownerId),
    index('exam_records_status_idx').on(t.extractionStatus),
    index('exam_records_linked_idx').on(t.linkedCurriculumDocId),
  ]
);

export const insertExamRecordSchema = createInsertSchema(examRecordsTable);
export const selectExamRecordSchema = createSelectSchema(examRecordsTable);
export type ExamRecord    = typeof examRecordsTable.$inferSelect;
export type InsertExamRecord = z.infer<typeof insertExamRecordSchema>;
