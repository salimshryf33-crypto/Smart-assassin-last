/**
 * lib/integrity/integrityChecker.ts
 *
 * Phase 4 — Orchestrates integrity rule evaluation for an entire exam and
 * persists the resulting IntegrityReport rows (append + supersede-by-time,
 * never overwritten — old issues are timestamped via detected_at and closed
 * via resolved_at rather than deleted).
 *
 * Never touches exam_questions, exam_canonical_answers, or any Phase 1-3
 * table except to READ from exam_canonical_answers.
 */
import { getSharedPool } from '../dbPool';
import { logger } from '../logger';
import { v4 as uuidv4 } from 'uuid';
import { runIntegrityRules, type IntegrityIssue, type IntegritySeverity } from './integrityRules';
import type { PipelineQuestion, CanonicalAnswer } from '../examValidation/types';

export interface IntegrityReport {
  examId:        string;
  generatedAt:   string;
  totalQuestions:number;
  issues:        IntegrityIssue[];
  bySeverity:    Record<IntegritySeverity, number>;
  blocking:      boolean; // true if any CRITICAL issue present
}

/**
 * Build (and persist) a fresh integrity report for an exam.
 * Loads questions + canonical answers via raw SQL — self-contained.
 */
export async function generateIntegrityReport(examId: string): Promise<IntegrityReport> {
  const pool = getSharedPool();

  const { rows: questionRows } = await pool.query<{
    id: string; exam_id: string; question: string; question_type: string;
    options: unknown; correct_answer: string | null; subject: string;
    grade: string; country: string; topic: string | null; chapter: string | null;
  }>(
    `SELECT id, exam_id, question, question_type, options, correct_answer,
            subject, grade, country, topic, chapter
     FROM public.exam_questions
     WHERE exam_id = $1`,
    [examId],
  );

  const { rows: answerRows } = await pool.query<{
    question_id: string; correct_option: string | null; confidence: string | null;
    reasoning_summary: string | null; evidence_chunk_ids: unknown; evidence_pages: unknown;
    validation_status: string; retrieval_version: number; attempt_count: number;
    last_attempt_at: Date | null; next_retry_at: Date | null; created_at: Date;
    updated_at: Date; verified: boolean; id: string;
  }>(
    `SELECT ca.* FROM public.exam_canonical_answers ca
     INNER JOIN public.exam_questions q ON q.id = ca.question_id
     WHERE q.exam_id = $1`,
    [examId],
  );

  const answerByQuestion = new Map<string, CanonicalAnswer>();
  for (const r of answerRows) {
    answerByQuestion.set(r.question_id, {
      id: r.id,
      questionId: r.question_id,
      correctOption: r.correct_option,
      confidence: r.confidence !== null ? parseFloat(r.confidence) : null,
      reasoningSummary: r.reasoning_summary,
      evidenceChunkIds: parseArr(r.evidence_chunk_ids),
      evidencePages: parseArr(r.evidence_pages),
      validationStatus: r.validation_status as CanonicalAnswer['validationStatus'],
      retrievalVersion: r.retrieval_version,
      attemptCount: r.attempt_count ?? 0,
      lastAttemptAt: r.last_attempt_at,
      nextRetryAt: r.next_retry_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      verified: r.verified,
    });
  }

  const questions: PipelineQuestion[] = questionRows.map((r) => ({
    id: r.id, examId: r.exam_id, question: r.question, questionType: r.question_type,
    options: r.options, correctAnswer: r.correct_answer, subject: r.subject,
    grade: r.grade, country: r.country, topic: r.topic, chapter: r.chapter,
  }));

  const issues: IntegrityIssue[] = [];
  for (const question of questions) {
    const answer = answerByQuestion.get(question.id) ?? null;
    issues.push(...runIntegrityRules({ question, answer }));
  }

  const bySeverity: Record<IntegritySeverity, number> = {
    CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, WARNING: 0,
  };
  for (const issue of issues) bySeverity[issue.severity]++;

  const report: IntegrityReport = {
    examId,
    generatedAt: new Date().toISOString(),
    totalQuestions: questions.length,
    issues,
    bySeverity,
    blocking: bySeverity.CRITICAL > 0,
  };

  await persistIssues(examId, issues);

  logger.info(
    { examId, totalQuestions: questions.length, bySeverity, blocking: report.blocking },
    'integrityChecker: report generated',
  );

  return report;
}

// ─── Persistence ───────────────────────────────────────────────────────────────
// Additive, idempotent: re-running the same check for the same question+ruleId
// updates detected_at rather than inserting a duplicate open issue.

async function persistIssues(examId: string, issues: IntegrityIssue[]): Promise<void> {
  const pool = getSharedPool();

  for (const issue of issues) {
    await pool.query(
      `INSERT INTO public.integrity_reports
         (id, exam_id, question_id, rule_id, severity, message, detected_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (question_id, rule_id) WHERE resolved_at IS NULL
       DO UPDATE SET detected_at = EXCLUDED.detected_at, message = EXCLUDED.message`,
      [uuidv4(), examId, issue.questionId, issue.ruleId, issue.severity, issue.message, issue.detectedAt],
    );
  }

  // Close out any previously-open issue for this exam that this run did NOT
  // re-detect — the issue lifecycle is open/closed, not append-only, so a
  // fixed question must stop showing up as blocking.
  const stillOpenKeys = issues.map((i) => `${i.questionId}::${i.ruleId}`);
  await pool.query(
    `UPDATE public.integrity_reports
     SET resolved_at = now()
     WHERE exam_id = $1
       AND resolved_at IS NULL
       AND (question_id || '::' || rule_id) NOT IN (
         SELECT unnest($2::text[])
       )`,
    [examId, stillOpenKeys.length > 0 ? stillOpenKeys : ['__none__']],
  );
}

function parseArr(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw as string[];
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) as string[]; } catch { return []; }
  }
  return [];
}
