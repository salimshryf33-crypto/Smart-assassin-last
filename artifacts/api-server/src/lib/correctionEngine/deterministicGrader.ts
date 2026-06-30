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
 */

import type { CorrectionResult } from './types';

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

function matchMCQ(student: string, correct: string): boolean {
  return normaliseForComparison(student) === normaliseForComparison(correct);
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

/** Question types that are always graded deterministically. */
export const DETERMINISTIC_TYPES = new Set<string>([
  'mcq',
  'true_false',
  'fill_in_blank',
]);

/**
 * Grade a student answer deterministically.
 * Never calls Gemini. No network I/O.
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
    gradingMethod:  'exact',
    aiFeedback:     null,
    evidenceStatus: 'SKIPPED',
    evidence:       null,
  };
}
