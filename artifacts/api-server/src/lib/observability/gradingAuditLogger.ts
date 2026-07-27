/**
 * lib/observability/gradingAuditLogger.ts
 *
 * Phase 3 — Unified grading audit pipeline.
 *
 * Wraps the existing logAuditEvent() so that every grading outcome —
 * across all 6 question types and all 4 grading paths (deterministic,
 * open_package, pending_preparation, unknown_type) — writes a single
 * structured 'grading_outcome' row into public.validation_audit_log
 * alongside the pre-existing validation pipeline events.
 *
 * Design constraints honoured:
 *   ✔ Reuses logAuditEvent()  — no new logging infrastructure
 *   ✔ Reuses validation_audit_log — no new tables, no schema changes
 *   ✔ All 12 required fields go into the existing JSONB payload column
 *   ✔ Fire-and-forget — never blocks the grading hot path
 *   ✔ Typed wrapper prevents missing fields at compile time
 *
 * GRADING_RULES_VERSION:
 *   Bump this constant whenever scoring logic, normalisation rules, or
 *   grading thresholds change. Audit records from different rule sets can
 *   then be distinguished in historical queries without re-running grades.
 *
 *   3.0.0 — Preparation-First phase: deterministic grading from stored
 *            packages; Gemini guard active; partial credit via scoreRatio.
 */

import { logAuditEvent } from './auditLogger.js';

// ─── Rules version ─────────────────────────────────────────────────────────────

/**
 * Semantic version of the active grading rules.
 * Written into every grading_outcome audit record so historical records
 * produced by older rule sets remain distinguishable.
 *
 * Bump policy:
 *   MAJOR — scoring formula or binary isCorrect threshold changes
 *   MINOR — new question type grading path added
 *   PATCH — normalisation fix or Arabic equivalence table update
 */
export const GRADING_RULES_VERSION = '3.0.0';

// ─── Domain types ──────────────────────────────────────────────────────────────

/**
 * Which preparation store supplied the grading package for this question.
 * null means no package was consumed (question deferred or type unknown).
 */
export type PreparationSource =
  | 'canonical_answers'   // exam_canonical_answers  — MCQ / true_false / fill_in_blank
  | 'open_preparations'   // exam_open_preparations  — short_answer / calculation / essay
  | null;                 // no package consumed     — pending or unknown type

/**
 * High-level outcome classification recorded for every graded question.
 * Allows dashboards and queries to aggregate without re-parsing gradingMethod.
 *
 * Mapping from raw result:
 *   gradingMethod='skipped'                → 'skipped'
 *   isCorrect=false                        → 'incorrect'
 *   isCorrect=true  && scoreRatio >= 1.0   → 'correct'
 *   isCorrect=true  && scoreRatio < 1.0    → 'partial'
 *   question deferred to next grading run  → 'pending_preparation'
 */
export type FinalClassification =
  | 'correct'
  | 'partial'
  | 'incorrect'
  | 'skipped'
  | 'pending_preparation';

/**
 * All 12 required fields captured for every graded (or deferred) question.
 *
 * Fields map to the payload JSONB column in validation_audit_log — the only
 * top-level columns consumed are examId, questionId, and the standard
 * event/severity/durationMs fields already present in AuditEvent.
 */
export interface GradingOutcomeEvent {
  // ── Identifiers ──────────────────────────────────────────────────────────
  examId:              string;   // → validation_audit_log.exam_id (indexed)
  questionId:          string;   // → validation_audit_log.question_id (indexed)
  attemptId:           string;   // → payload.attemptId

  // ── Question metadata ────────────────────────────────────────────────────
  questionType:        string;   // mcq | true_false | fill_in_blank | short_answer | ...

  // ── Strategy & source ────────────────────────────────────────────────────
  /** Which grading path was taken for this question. */
  gradingStrategy:     'deterministic' | 'open_package' | 'pending_preparation' | 'unknown_type';
  /** Which preparation store supplied the grading package, or null if deferred. */
  preparationSource:   PreparationSource;

  // ── Versioning ───────────────────────────────────────────────────────────
  /** retrieval_version from the prep store at grading time; null when deferred. */
  preparationVersion:  number | null;
  /** Active grading rules version — GRADING_RULES_VERSION constant. */
  rulesVersion:        string;

  // ── Evidence quality ─────────────────────────────────────────────────────
  /** 0–1 confidence score from the prep store; null for deterministic types. */
  confidence:          number | null;
  /** validation_status / preparation_status from the store at grading time. */
  preparationStatus:   string | null;

  // ── Outcome ──────────────────────────────────────────────────────────────
  finalClassification: FinalClassification;
  /** Maps to the existing gradingMethod DB column for backward compat. */
  gradingMethod:       string;
  /** Proportional correctness 0.0–1.0; 0 for deferred/skipped. */
  scoreRatio:          number;
  /** null only for pending_preparation and unknown_type paths. */
  isCorrect:           boolean | null;

  // ── Timing ───────────────────────────────────────────────────────────────
  /** Wall-clock time in ms from start of question processing to audit emit. */
  durationMs:          number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Derive the FinalClassification from a live CorrectionResult.
 * For deferred paths (pending_preparation, unknown_type), use the literal
 * 'pending_preparation' directly rather than calling this helper.
 */
export function deriveFinalClassification(
  isCorrect:     boolean,
  scoreRatio:    number,
  gradingMethod: string,
): FinalClassification {
  if (gradingMethod === 'skipped') return 'skipped';
  if (!isCorrect)                  return 'incorrect';
  if (scoreRatio >= 1.0)           return 'correct';
  return 'partial';
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Emit one 'grading_outcome' audit event for a single question.
 *
 * Delegates to logAuditEvent() which:
 *   1. Writes a structured pino JSON log line immediately (synchronous).
 *   2. Fire-and-forgets a durable write to public.validation_audit_log.
 *
 * Never throws — safe to call in the grading hot path without try/catch.
 *
 * Usage: call once per question, immediately after the grading decision
 * is persisted to exam_answers, before the loop continues.
 */
export function logGradingOutcome(evt: GradingOutcomeEvent): void {
  // pending_preparation is a normal operating state (Preparation-First model),
  // but worth flagging at warn so dashboards can surface question readiness gaps.
  const severity: 'info' | 'warn' =
    evt.finalClassification === 'pending_preparation' ? 'warn' : 'info';

  logAuditEvent({
    examId:     evt.examId,
    questionId: evt.questionId,
    event:      'grading_outcome',
    severity,
    durationMs: evt.durationMs,
    payload: {
      // Identifiers
      attemptId:           evt.attemptId,
      questionType:        evt.questionType,

      // Strategy & source
      gradingStrategy:     evt.gradingStrategy,
      preparationSource:   evt.preparationSource,

      // Versioning
      preparationVersion:  evt.preparationVersion,
      rulesVersion:        evt.rulesVersion,

      // Evidence quality
      confidence:          evt.confidence,
      preparationStatus:   evt.preparationStatus,

      // Outcome
      finalClassification: evt.finalClassification,
      gradingMethod:       evt.gradingMethod,
      scoreRatio:          evt.scoreRatio,
      isCorrect:           evt.isCorrect,
    },
  });
}
