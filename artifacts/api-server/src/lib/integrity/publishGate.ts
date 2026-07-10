/**
 * lib/integrity/publishGate.ts
 *
 * Phase 4 — Publish safety gate, EXTENDS the existing
 * canonicalAnswerStore.getPublishReadiness() check (Phase 1-3, unchanged)
 * with the new integrity report. Does not replace the existing gate in
 * routes/exam.ts /publish — that check still runs and still applies.
 *
 * This module adds a SECOND, stricter gate specifically for the new
 * enterprise integrity workflow, exposed via new admin endpoints only.
 */
import { getPublishReadiness } from '../examValidation/canonicalAnswerStore';
import { generateIntegrityReport, type IntegrityReport } from './integrityChecker';
import type { PublishReadinessResult } from '../examValidation/types';

export interface PublishGateResult {
  canPublish:  boolean;
  reasons:     string[];
  readiness:   PublishReadinessResult;
  integrity:   IntegrityReport;
}

/**
 * Publishing is blocked if:
 *   - Critical integrity issues exist
 *   - Validation is incomplete (existing readiness check fails)
 *   - Canonical answer missing for any MCQ/true_false question
 *   - Evidence missing for any READY answer
 * All of the above collapse into "any CRITICAL issue" in the integrity
 * report, plus the pre-existing readiness.ready flag.
 */
export async function evaluatePublishGate(examId: string): Promise<PublishGateResult> {
  const [readiness, integrity] = await Promise.all([
    getPublishReadiness(examId),
    generateIntegrityReport(examId),
  ]);

  const reasons: string[] = [];
  if (!readiness.ready) {
    reasons.push(
      `Validation incomplete: ${readiness.blockingQuestions.length} of ${readiness.totalMcq} MCQ questions are not READY`,
    );
  }
  if (integrity.blocking) {
    const critical = integrity.issues.filter((i) => i.severity === 'CRITICAL');
    reasons.push(`${critical.length} critical integrity issue(s) detected`);
  }

  return {
    canPublish: reasons.length === 0,
    reasons,
    readiness,
    integrity,
  };
}
