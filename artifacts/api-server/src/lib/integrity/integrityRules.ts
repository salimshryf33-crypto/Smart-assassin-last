/**
 * lib/integrity/integrityRules.ts
 *
 * Phase 4 — Enterprise Exam Integrity Layer.
 *
 * Pure rule definitions. Each rule inspects a question + its canonical
 * answer (if any) and returns zero or more IntegrityIssue objects.
 * No I/O — safe to unit test in isolation.
 */
import type { PipelineQuestion, CanonicalAnswer } from '../examValidation/types';

export type IntegritySeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'WARNING';

export interface IntegrityIssue {
  ruleId:     string;
  severity:   IntegritySeverity;
  message:    string;
  questionId: string;
  detectedAt: string;   // ISO timestamp
}

export interface IntegrityRuleInput {
  question: PipelineQuestion;
  answer:   CanonicalAnswer | null;
}

type Rule = (input: IntegrityRuleInput) => Omit<IntegrityIssue, 'questionId' | 'detectedAt'> | null;

/** Severities that block publishing outright. */
export const BLOCKING_SEVERITIES: IntegritySeverity[] = ['CRITICAL'];

/** Severities that require admin review before publish (do not auto-block). */
export const REVIEW_SEVERITIES: IntegritySeverity[] = ['HIGH'];

// ─── Rule: canonical answer missing for a question that requires one ─────────
const ruleMissingCanonicalAnswer: Rule = ({ question, answer }) => {
  const requiresAnswer = question.questionType === 'mcq' || question.questionType === 'true_false';
  if (!requiresAnswer) return null;
  if (!answer || !answer.correctOption) {
    return {
      ruleId:   'MISSING_CANONICAL_ANSWER',
      severity: 'CRITICAL',
      message:  'No canonical answer recorded for a question type that requires one',
    };
  }
  return null;
};

// ─── Rule: validation status not READY ────────────────────────────────────────
const ruleNotReady: Rule = ({ answer }) => {
  if (!answer) return null;
  if (answer.validationStatus === 'READY') return null;
  if (answer.validationStatus === 'INVALID') {
    return {
      ruleId:   'VALIDATION_INVALID',
      severity: 'CRITICAL',
      message:  'Question failed structural integrity validation',
    };
  }
  if (answer.validationStatus === 'PERMANENT_LOW_EVIDENCE') {
    return {
      ruleId:   'PERMANENT_LOW_EVIDENCE',
      severity: 'CRITICAL',
      message:  'Curriculum evidence exhausted — canonical answer could not be derived',
    };
  }
  return {
    ruleId:   'VALIDATION_INCOMPLETE',
    severity: 'HIGH',
    message:  `Validation still in progress (status=${answer.validationStatus})`,
  };
};

// ─── Rule: evidence missing for a READY answer ────────────────────────────────
const ruleMissingEvidence: Rule = ({ answer }) => {
  if (!answer || answer.validationStatus !== 'READY') return null;
  if (!answer.evidenceChunkIds || answer.evidenceChunkIds.length === 0) {
    return {
      ruleId:   'MISSING_EVIDENCE',
      severity: 'CRITICAL',
      message:  'READY answer has no curriculum evidence chunks attached',
    };
  }
  return null;
};

// ─── Rule: low confidence, but still READY (near-threshold) ──────────────────
const CONFIDENCE_REVIEW_THRESHOLD = 0.80;
const ruleLowConfidenceReady: Rule = ({ answer }) => {
  if (!answer || answer.validationStatus !== 'READY') return null;
  if (answer.confidence !== null && answer.confidence < CONFIDENCE_REVIEW_THRESHOLD) {
    return {
      ruleId:   'LOW_CONFIDENCE_READY',
      severity: 'MEDIUM',
      message:  `Confidence ${answer.confidence.toFixed(2)} is below the review threshold ${CONFIDENCE_REVIEW_THRESHOLD}`,
    };
  }
  return null;
};

// ─── Rule: unverified answer (never manually reviewed) ───────────────────────
const ruleUnverified: Rule = ({ answer }) => {
  if (!answer || answer.validationStatus !== 'READY') return null;
  if (!answer.verified) {
    return {
      ruleId:   'UNVERIFIED_ANSWER',
      severity: 'LOW',
      message:  'Canonical answer has not been manually verified by an admin',
    };
  }
  return null;
};

// ─── Rule: high attempt count (informational) ─────────────────────────────────
const ruleHighAttemptCount: Rule = ({ answer }) => {
  if (!answer) return null;
  if (answer.attemptCount >= 3 && answer.validationStatus === 'READY') {
    return {
      ruleId:   'HIGH_ATTEMPT_COUNT',
      severity: 'WARNING',
      message:  `Answer became READY only after ${answer.attemptCount} attempts`,
    };
  }
  return null;
};

const ALL_RULES: Rule[] = [
  ruleMissingCanonicalAnswer,
  ruleNotReady,
  ruleMissingEvidence,
  ruleLowConfidenceReady,
  ruleUnverified,
  ruleHighAttemptCount,
];

export function runIntegrityRules(input: IntegrityRuleInput): IntegrityIssue[] {
  const detectedAt = new Date().toISOString();
  const issues: IntegrityIssue[] = [];
  for (const rule of ALL_RULES) {
    const result = rule(input);
    if (result) {
      issues.push({ ...result, questionId: input.question.id, detectedAt });
    }
  }
  return issues;
}
