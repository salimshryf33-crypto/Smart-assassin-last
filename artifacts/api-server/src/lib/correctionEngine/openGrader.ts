/**
 * correctionEngine/openGrader.ts
 *
 * Deterministic grading for open-ended question types using ONLY the stored
 * preparation package.  No Gemini. No network. No curriculum search.
 *
 * Called during grading when the question's open preparation is READY.
 *
 * Scoring strategies:
 *
 *   short_answer:
 *     1. Direct match against canonicalAnswer or acceptedSemanticAnswers → 1.0
 *     2. Required-concept coverage score (fraction of concepts found)
 *     3. Keyword coverage bonus
 *     Final: direct match wins; otherwise concept + keyword coverage
 *
 *   calculation:
 *     1. Extract numeric value from student answer
 *     2. Within numericTolerance of expectedNumericResult → 1.0
 *     3. If no numeric match, check requiredConcepts coverage (partial credit)
 *
 *   essay:
 *     1. Required-concept coverage (fraction present in student answer)
 *     2. Scoring-criteria coverage
 *     Final: weighted average of both
 *
 * All string comparisons use the same Arabic normalisation as deterministicGrader.ts.
 * scoreRatio 0.0–1.0; isCorrect = scoreRatio >= 0.5.
 */

import type { CorrectionResult }    from './types';
import type {
  OpenPreparationPackage,
  ShortAnswerPackage,
  CalculationPackage,
  EssayPackage,
} from '../examValidation/openPreparationDeriver';
import type { QuestionCorrectionInput } from './types';
import { logger } from '../logger';

// Threshold above which a scoreRatio is "correct"
const CORRECT_THRESHOLD = 0.5;

// ─── Arabic-aware normalisation (mirrors deterministicGrader.ts) ─────────────

function normalise(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/\s+/g, ' ');
}

/** True when normA === normB (exact) or normA includes normB as a phrase. */
function softMatch(a: string, b: string): boolean {
  const na = normalise(a);
  const nb = normalise(b);
  return na === nb || na.includes(nb) || nb.includes(na);
}

/**
 * Fraction of `concepts` that appear (as substring) in `text` after normalisation.
 */
function conceptCoverage(text: string, concepts: string[]): number {
  if (concepts.length === 0) return 1.0; // vacuously satisfied
  const normText = normalise(text);
  const found    = concepts.filter((c) => normText.includes(normalise(c)));
  return found.length / concepts.length;
}

// ─── Short-answer grading ─────────────────────────────────────────────────────

function gradeShortAnswer(
  studentAnswer: string,
  pkg:           ShortAnswerPackage,
  questionId:    string,
): CorrectionResult {
  // 1. Direct match check (canonical + accepted variants)
  const allAccepted = [pkg.canonicalAnswer, ...pkg.acceptedSemanticAnswers];
  const directMatch = allAccepted.some((accepted) => softMatch(studentAnswer, accepted));

  if (directMatch) {
    logger.debug({ questionId }, 'openGrader: short_answer — direct match → 1.0');
    return {
      isCorrect:      true,
      scoreRatio:     1.0,
      gradingMethod:  'exact',
      aiFeedback:     'إجابة صحيحة.',
      evidenceStatus: 'SKIPPED',
      evidence:       null,
    };
  }

  // 2. Required-concept coverage
  const conceptScore = conceptCoverage(studentAnswer, pkg.requiredConcepts);

  // 3. Keyword coverage
  const keywordScore = pkg.acceptedKeywords.length > 0
    ? conceptCoverage(studentAnswer, pkg.acceptedKeywords)
    : 0;

  // 4. Weighted score: 70% concepts + 30% keywords
  const scoreRatio   = Math.min(1.0, 0.7 * conceptScore + 0.3 * keywordScore);
  const isCorrect    = scoreRatio >= CORRECT_THRESHOLD;

  let feedback: string;
  if (scoreRatio === 0) {
    feedback = 'الإجابة غير صحيحة.';
  } else if (isCorrect) {
    feedback = `إجابة جزئية صحيحة (${Math.round(scoreRatio * 100)}٪ من المفاهيم المطلوبة).`;
  } else {
    feedback = `إجابة منقوصة (${Math.round(scoreRatio * 100)}٪ من المفاهيم المطلوبة).`;
  }

  logger.debug({ questionId, scoreRatio, conceptScore, keywordScore }, 'openGrader: short_answer — scored');
  return {
    isCorrect,
    scoreRatio,
    gradingMethod:  'exact',
    aiFeedback:     feedback,
    evidenceStatus: 'SKIPPED',
    evidence:       null,
  };
}

// ─── Calculation grading ──────────────────────────────────────────────────────

/** Extract the first parseable number from a string. */
function extractNumber(text: string): number | null {
  // Remove Arabic-Indic numerals → Latin equivalents
  const latinised = text
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/،/g, '.');               // Arabic decimal separator

  // Match: optional sign, digits, optional decimal
  const match = latinised.match(/-?\d+(?:[.,]\d+)?/);
  if (!match) return null;
  const n = parseFloat(match[0].replace(',', '.'));
  return isNaN(n) ? null : n;
}

function gradeCalculation(
  studentAnswer: string,
  pkg:           CalculationPackage,
  questionId:    string,
): CorrectionResult {
  // 1. Numeric match (if expectedNumericResult is available)
  if (pkg.expectedNumericResult !== null) {
    const studentNum = extractNumber(studentAnswer);

    if (studentNum !== null) {
      const tolerance  = pkg.numericTolerance > 0 ? pkg.numericTolerance : 0.05;
      const expected   = pkg.expectedNumericResult;
      const diff       = Math.abs(studentNum - expected);
      // Relative tolerance when expected ≠ 0, absolute otherwise
      const relDiff    = expected !== 0 ? diff / Math.abs(expected) : diff;
      const withinTol  = relDiff <= tolerance;

      if (withinTol) {
        logger.debug({ questionId, studentNum, expected, relDiff }, 'openGrader: calculation — numeric match');
        return {
          isCorrect:      true,
          scoreRatio:     1.0,
          gradingMethod:  'exact',
          aiFeedback:     'الإجابة الرقمية صحيحة.',
          evidenceStatus: 'SKIPPED',
          evidence:       null,
        };
      }

      // Numbers extracted but wrong — no partial credit for numeric questions
      const conceptScore = conceptCoverage(studentAnswer, pkg.requiredConcepts);
      const scoreRatio   = Math.min(0.4, conceptScore * 0.4); // partial only for concept presence
      logger.debug({ questionId, studentNum, expected, relDiff }, 'openGrader: calculation — numeric wrong');
      return {
        isCorrect:      false,
        scoreRatio,
        gradingMethod:  'exact',
        aiFeedback:     `الإجابة الرقمية غير صحيحة. الإجابة الصحيحة: ${pkg.canonicalAnswer}`,
        evidenceStatus: 'SKIPPED',
        evidence:       null,
      };
    }
  }

  // 2. No numeric result stored OR student gave no number — fall back to concept coverage
  const conceptScore = conceptCoverage(studentAnswer, pkg.requiredConcepts);
  const scoreRatio   = Math.min(0.5, conceptScore * 0.5); // cap at 0.5 without numeric match
  const isCorrect    = scoreRatio >= CORRECT_THRESHOLD;

  logger.debug({ questionId, conceptScore, scoreRatio }, 'openGrader: calculation — concept fallback');
  return {
    isCorrect,
    scoreRatio,
    gradingMethod:  'exact',
    aiFeedback:     isCorrect
      ? `إجابة جزئية — الإجابة الكاملة: ${pkg.canonicalAnswer}`
      : `الإجابة غير صحيحة. الإجابة الصحيحة: ${pkg.canonicalAnswer}`,
    evidenceStatus: 'SKIPPED',
    evidence:       null,
  };
}

// ─── Essay grading ────────────────────────────────────────────────────────────

function gradeEssay(
  studentAnswer: string,
  pkg:           EssayPackage,
  questionId:    string,
): CorrectionResult {
  // 1. Required-concept coverage
  const conceptScore   = conceptCoverage(studentAnswer, pkg.requiredConcepts);

  // 2. Scoring-criteria coverage
  const criteriaScore  = conceptCoverage(studentAnswer, pkg.scoringCriteria);

  // 3. Scientific guard concepts (bonus weight: presence signals deeper understanding)
  const guardScore     = pkg.scientificGuardConcepts.length > 0
    ? conceptCoverage(studentAnswer, pkg.scientificGuardConcepts)
    : conceptScore; // if none defined, use concept score again

  // Weighted: 50% concept coverage + 30% criteria + 20% guard
  const scoreRatio   = Math.min(1.0, 0.5 * conceptScore + 0.3 * criteriaScore + 0.2 * guardScore);
  const isCorrect    = scoreRatio >= CORRECT_THRESHOLD;

  let feedback: string;
  if (scoreRatio >= 0.85) {
    feedback = 'إجابة ممتازة تغطي معظم النقاط الجوهرية.';
  } else if (isCorrect) {
    feedback = `إجابة مقبولة (${Math.round(scoreRatio * 100)}٪ من المعايير).`;
  } else {
    feedback = `إجابة منقوصة (${Math.round(scoreRatio * 100)}٪ من المعايير المطلوبة).`;
  }

  logger.debug({ questionId, scoreRatio, conceptScore, criteriaScore, guardScore }, 'openGrader: essay — scored');
  return {
    isCorrect,
    scoreRatio,
    gradingMethod:  'exact',
    aiFeedback:     feedback,
    evidenceStatus: 'SKIPPED',
    evidence:       null,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Grade an open-ended answer using ONLY the stored preparation package.
 * No Gemini. No network. Pure deterministic evaluation.
 */
export function gradeWithOpenPackage(
  input: QuestionCorrectionInput,
  pkg:   OpenPreparationPackage,
): CorrectionResult {
  // Empty answer guard
  if (!input.studentAnswer?.trim()) {
    return {
      isCorrect:      false,
      scoreRatio:     0,
      gradingMethod:  'skipped',
      aiFeedback:     'لم تقدم إجابة.',
      evidenceStatus: 'SKIPPED',
      evidence:       null,
    };
  }

  const studentAnswer = input.studentAnswer;
  const questionId    = input.questionId;

  switch (pkg.type) {
    case 'short_answer':
      return gradeShortAnswer(studentAnswer, pkg, questionId);

    case 'calculation':
      return gradeCalculation(studentAnswer, pkg, questionId);

    case 'essay':
      return gradeEssay(studentAnswer, pkg, questionId);

    default: {
      // TypeScript exhaustiveness check
      const _exhaustive: never = pkg;
      logger.error({ pkg: _exhaustive, questionId }, 'openGrader: unknown package type');
      return {
        isCorrect:      false,
        scoreRatio:     0,
        gradingMethod:  'skipped',
        aiFeedback:     null,
        evidenceStatus: 'SKIPPED',
        evidence:       null,
      };
    }
  }
}
