/**
 * correctionEngine/deterministicGrader.ts
 *
 * Responsible ONLY for deterministic correction — never calls Gemini.
 *
 * Deterministic strategies:
 *  - MCQ               → normalised string equality (Arabic-aware)
 *  - true_false        → normalised boolean equivalence (صح / خطأ / true / false)
 *  - fill_in_blank     → normalised string equality (same as MCQ)
 *
 * Arabic normalisation removes diacritics and standardises common variant
 * characters so that e.g. "أ" and "ا" are treated as equivalent.
 *
 * scoreRatio is always binary for deterministic types:
 *   Correct   → 1.0
 *   Incorrect → 0.0
 *   Skipped   → 0.0
 */

import type { CorrectionResult } from './types';
import { DETERMINISTIC_TYPES } from '../questionTypeRegistry';

// Re-export so existing callers (correctionEngine/index.ts, autoGrader.ts)
// continue to import DETERMINISTIC_TYPES from this module unchanged.
export { DETERMINISTIC_TYPES };

// ─── Arabic-aware normalisation ───────────────────────────────────────────────

/**
 * Normalise a string for deterministic comparison.
 * Strips diacritics, lowercases, collapses whitespace, and maps common
 * Arabic character variants to a canonical form.
 */
function normaliseForComparison(text: string): string {
  return text
    .trim()
    .toLowerCase()
    // Strip Arabic diacritics (tashkeel) and tatweel
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    // Alif variants → bare alif
    .replace(/[أإآ]/g, 'ا')
    // Ta-marbuta → ha
    .replace(/ة/g, 'ه')
    // Alif maqsura → ya
    .replace(/ى/g, 'ي')
    // Collapse whitespace
    .replace(/\s+/g, ' ');
}

// ─── Type-specific matchers ───────────────────────────────────────────────────

/**
 * Extract the leading option key from a normalised MCQ string.
 *
 * Handles the common Arabic exam pattern where options are formatted as:
 *   "أ) الخلية النباتية"  → key = "ا"   (alif after normalisation)
 *   "a) cell"             → key = "a"
 *   "1- item"             → key = "1"
 *
 * Returns null when no key+separator pattern is found (e.g. bare text).
 */
function extractOptionKey(normalised: string): string | null {
  // Match: one char (Arabic letter or a-z or digit) followed by ) . - or :
  const m = normalised.match(/^([a-z\u0600-\u06ff\d])\s*[).:\-]/i);
  return m ? m[1]!.toLowerCase() : null;
}

/**
 * Robust MCQ matcher.
 *
 * Handles four common answer-format mismatches produced by Gemini extraction:
 *   1. Exact match (normalised):  "الخلية" === "الخلية"
 *   2. Both have option keys:     "أ) الخلية" vs "أ) الخلية" → compare keys
 *   3. Correct is bare key:       correctAnswer = "أ", student = "أ) الخلية"
 *   4. Student is bare key:       student = "أ", correctAnswer = "أ) الخلية"
 */
function matchMCQ(student: string, correct: string): boolean {
  const ns = normaliseForComparison(student).trim();
  const nc = normaliseForComparison(correct).trim();

  // Fast path: exact match after normalisation
  if (ns === nc) return true;

  const sKey = extractOptionKey(ns);
  const cKey = extractOptionKey(nc);

  // Both have parseable option keys → compare keys only
  if (sKey !== null && cKey !== null) return sKey === cKey;

  // correctAnswer is a bare single-char key (e.g. stored as "أ" or "a")
  // student selected the full option text (e.g. "أ) الخلية النباتية")
  if (sKey !== null && nc.length <= 2) {
    return sKey === nc.toLowerCase();
  }

  // student answered with a bare key, correctAnswer has the full option text
  if (cKey !== null && ns.length <= 2) {
    return cKey === ns.toLowerCase();
  }

  return false;
}

function matchTrueFalse(student: string, correct: string): boolean {
  const canonicalise = (v: string): string => {
    const n = normaliseForComparison(v);
    if (['true',  'صح', 'صحيح', 'نعم', '1'].includes(n)) return 'true';
    if (['false', 'خطا', 'خطأ', 'لا',  '0'].includes(n)) return 'false';
    return n;
  };
  return canonicalise(student) === canonicalise(correct);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Grade a student answer deterministically.
 * Never calls Gemini. No network I/O.
 * scoreRatio is always 1.0 (correct) or 0.0 (incorrect/skipped).
 */
export function gradeDeterministic(
  studentAnswer: string | null,
  correctAnswer: string | null,
  questionType:  string
): CorrectionResult {
  // Empty answer
  if (!studentAnswer?.trim()) {
    return {
      isCorrect:      false,
      scoreRatio:     0,
      gradingMethod:  'skipped',
      aiFeedback:     'لم تقدم إجابة.',
      evidenceStatus: 'SKIPPED',
      evidence:       null,
    };
  }

  // No model answer stored
  if (!correctAnswer?.trim()) {
    return {
      isCorrect:      false,
      scoreRatio:     0,
      gradingMethod:  'exact',
      aiFeedback:     null,
      evidenceStatus: 'SKIPPED',
      evidence:       null,
    };
  }

  let isCorrect = false;

  if (questionType === 'true_false') {
    isCorrect = matchTrueFalse(studentAnswer, correctAnswer);
  } else {
    // mcq, fill_in_blank, and any future exact-match type
    isCorrect = matchMCQ(studentAnswer, correctAnswer);
  }

  return {
    isCorrect,
    scoreRatio:     isCorrect ? 1.0 : 0.0,
    gradingMethod:  'exact',
    aiFeedback:     null,
    evidenceStatus: 'SKIPPED',
    evidence:       null,
  };
}
