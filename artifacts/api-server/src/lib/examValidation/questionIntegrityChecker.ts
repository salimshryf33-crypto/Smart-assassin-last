/**
 * examValidation/questionIntegrityChecker.ts
 *
 * Validates the structural integrity of a question before it enters the
 * canonical answer pipeline.  Pure function — no I/O, no side effects.
 *
 * Rules checked:
 *   1. Question text is non-null and non-empty
 *   2. questionType is a known value
 *   3. MCQ / true_false questions have a non-empty options array
 *   4. MCQ options count is within bounds (2-6)
 *   5. No option is empty or whitespace-only
 *   6. No duplicate options (case/whitespace normalised)
 *   7. short_answer / essay / calculation / fill_in_blank questions are
 *      structurally valid (no options required)
 *
 * All type sets are imported from questionTypeRegistry — never duplicated here.
 */

import type { PipelineQuestion, QuestionIntegrityResult } from './types';
import {
  KNOWN_TYPES,
  OPTION_REQUIRED_TYPES,
  CANONICAL_ANSWER_REQUIRED_TYPES,
} from '../questionTypeRegistry';

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 6;

// ─── Public API ───────────────────────────────────────────────────────────────

export function checkQuestionIntegrity(
  question: PipelineQuestion,
): QuestionIntegrityResult {
  // Rule 1 — question text
  if (!question.question?.trim()) {
    return fail('Question text is empty or null');
  }

  // Rule 2 — known questionType
  if (!KNOWN_TYPES.has(question.questionType)) {
    return fail(`Unknown questionType: "${question.questionType}"`);
  }

  // Rules 3-6 apply only to types that need options
  if (OPTION_REQUIRED_TYPES.has(question.questionType)) {
    const options = parseOptions(question.options);

    if (!options || options.length === 0) {
      return fail(`${question.questionType} question has no options`);
    }

    if (options.length < MIN_OPTIONS) {
      return fail(
        `${question.questionType} question has ${options.length} option(s); minimum is ${MIN_OPTIONS}`
      );
    }

    if (options.length > MAX_OPTIONS) {
      return fail(
        `${question.questionType} question has ${options.length} options; maximum is ${MAX_OPTIONS}`
      );
    }

    for (const opt of options) {
      if (!opt?.trim()) {
        return fail('At least one option is empty or whitespace-only');
      }
    }

    const normalised = options.map((o) => o.trim().toLowerCase());
    const unique = new Set(normalised);
    if (unique.size < normalised.length) {
      return fail('Duplicate options detected');
    }
  }

  return { passed: true };
}

/**
 * Returns true when this question type needs a canonical answer at all.
 * essay / short_answer / calculation use the AI grader; they don't need
 * a deterministic correctOption.
 * fill_in_blank DOES need one — it is graded by exact-match.
 */
export function requiresCanonicalAnswer(questionType: string): boolean {
  return CANONICAL_ANSWER_REQUIRED_TYPES.has(questionType);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fail(reason: string): QuestionIntegrityResult {
  return { passed: false, reason };
}

function parseOptions(raw: unknown): string[] | null {
  if (!raw) return null;
  if (Array.isArray(raw)) return raw as string[];
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as string[]) : null;
    } catch {
      return null;
    }
  }
  return null;
}
