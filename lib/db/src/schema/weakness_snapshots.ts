import { pgTable, serial, text, integer, jsonb, timestamp, unique, index } from 'drizzle-orm/pg-core';
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import { z } from 'zod/v4';
import { sql } from 'drizzle-orm';

export const weaknessSnapshotsTable = pgTable(
  'weakness_snapshots',
  {
    id:          serial('id').primaryKey(),
    studentId:   text('student_id').notNull(),
    country:     text('country').notNull(),
    grade:       text('grade').notNull(),
    subject:     text('subject').notNull(),
    /**
     * Record<topic, { correct: number; total: number; score: number }>
     * score = correct / total (0 = worst, 1 = best)
     * weakness = 1 - score
     */
    topicScores: jsonb('topic_scores').notNull().default(sql`'{}'::jsonb`),
    totalExams:  integer('total_exams').default(0),
    lastUpdated: timestamp('last_updated', { withTimezone: true }).default(sql`NOW()`).notNull(),
  },
  (t) => [
    unique('weakness_snapshots_unique').on(t.studentId, t.country, t.grade, t.subject),
    index('weakness_snapshots_student_idx').on(t.studentId),
  ]
);

export const insertWeaknessSnapshotSchema = createInsertSchema(weaknessSnapshotsTable).omit({ id: true });
export const selectWeaknessSnapshotSchema = createSelectSchema(weaknessSnapshotsTable);
export type WeaknessSnapshot       = typeof weaknessSnapshotsTable.$inferSelect;
export type InsertWeaknessSnapshot = z.infer<typeof insertWeaknessSnapshotSchema>;

// ── Typed topic score map ─────────────────────────────────────────────────────
export interface TopicScore {
  correct: number;
  total:   number;
  score:   number;   // correct / total
}
export type TopicScoreMap = Record<string, TopicScore>;
