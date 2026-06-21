/**
 * ocrQualityAnalyzer — lightweight quality scorer for Arabic OCR output.
 *
 * ─── ARCHITECTURE RULE ───────────────────────────────────────────────────────
 * This module is a NON-DESTRUCTIVE ENHANCEMENT LAYER only.
 * The existing OCR pipeline in pdfExtractor.ts is UNCHANGED.
 * This module is called AFTER OCR completes to evaluate the result quality.
 * If quality is acceptable (score ≥ threshold), the result passes through
 * with ZERO change to behavior. Recovery only triggers on low-confidence text.
 *
 * ─── FEATURE FLAG ────────────────────────────────────────────────────────────
 * OCR_QUALITY_MIN_SCORE (env var, default: 30)
 *   Score below this → "low confidence" → recovery pipeline may be triggered.
 *   Set to 0 to effectively disable quality gating (quality analysis still
 *   runs and logs, but never triggers recovery).
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OcrQualityAnalysis {
  arabicWordCount: number;      // words with ≥2 consecutive Arabic chars
  uniqueWordRatio: number;      // unique words / total words (diversity metric)
  questionPatternCount: number; // question-like patterns found in text
  dotRatio: number;             // dot chars / total chars
  totalChars: number;
  score: number;                // 0–100 composite quality score
  isLowConfidence: boolean;     // true when score < OCR_QUALITY_MIN_SCORE
  reason: string;               // human-readable explanation for the score
}

export interface QuestionPatternDetection {
  count: number;                // total pattern categories matched
  hasNumberedItems: boolean;    // e.g.  ١- ... or 1. ...
  hasQuestionWords: boolean;    // e.g.  اشرح / اذكر / احسب / ما هو
  hasQuestionMarks: boolean;    // ؟ or ?
  hasMcqOptions: boolean;       // أ / ب / ج / د or a) b) c) d)
}

// ─── Thresholds ───────────────────────────────────────────────────────────────
// Conservative by design: working PDFs score well above these values.
// Only genuinely garbled OCR output falls below the threshold.

const DEFAULT_MIN_QUALITY_SCORE = 30; // overrideable via OCR_QUALITY_MIN_SCORE
const MIN_ARABIC_WORDS_FOR_GOOD = 5;  // below this always low confidence

// ─── Patterns ─────────────────────────────────────────────────────────────────

const ARABIC_WORD_RE      = /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]{2,}/g;
const NUMBERED_ITEM_RE    = /[١٢٣٤٥٦٧٨٩\d][\s.)-]/;
// Phase 1 enhancement: added علل، فسّر/فسر، ما المقصود، عِلَّة، ناقش، برهن، أثبت
const QUESTION_WORD_RE    = /اشرح|عرّف|عرف|اذكر|قارن|وضّح|وضح|احسب|أكمل|اختر|بيّن|بين|ما\s+هو|ما\s+هي|السؤال|علّل|علل|فسّر|فسر|ما\s+المقصود|ناقش|برهن|أثبت|استنتج|صنّف|صنف|حدد|قيّم|قيم|ارسم|احسب/;
const QUESTION_MARK_RE    = /[؟?]/;
const MCQ_OPTION_RE       = /[أابجدABCD][\s)/.-]/i;

// ─── Main analyser ────────────────────────────────────────────────────────────

/**
 * Score the quality of an OCR text string.
 *
 * Returns a composite score 0–100 and a boolean `isLowConfidence` flag.
 * Working PDFs with readable Arabic content will comfortably score ≥ 50.
 */
export function analyzeOcrText(text: string): OcrQualityAnalysis {
  if (!text || text.trim().length === 0) {
    return {
      arabicWordCount: 0,
      uniqueWordRatio: 0,
      questionPatternCount: 0,
      dotRatio: 0,
      totalChars: 0,
      score: 0,
      isLowConfidence: true,
      reason: 'empty text',
    };
  }

  const totalChars = text.length;

  // ── Dot ratio ────────────────────────────────────────────────────────────
  const dotCount = (text.match(/\./g) || []).length;
  const dotRatio = dotCount / totalChars;

  // ── Arabic word count ─────────────────────────────────────────────────────
  const arabicWords = text.match(ARABIC_WORD_RE) || [];
  const arabicWordCount = arabicWords.length;

  // ── Word diversity ────────────────────────────────────────────────────────
  const allWords = text.split(/\s+/).filter(Boolean);
  const uniqueWords = new Set(allWords.map((w) => w.toLowerCase()));
  const uniqueWordRatio = allWords.length > 0 ? uniqueWords.size / allWords.length : 0;

  // ── Question pattern count ────────────────────────────────────────────────
  let questionPatternCount = 0;
  if (NUMBERED_ITEM_RE.test(text))     questionPatternCount++;
  if (QUESTION_WORD_RE.test(text))     questionPatternCount++;
  if (QUESTION_MARK_RE.test(text))     questionPatternCount++;
  if (MCQ_OPTION_RE.test(text))        questionPatternCount++;

  // ── Composite score (0–100) ───────────────────────────────────────────────
  //   40 pts  Arabic word count   (≥40 words = full score; linear below)
  //   30 pts  word diversity       (50%+ unique = 30 pts)
  //   20 pts  question patterns    (5 pts per category, max 20)
  //   10 pts  dot penalty          (deducted when dotRatio > 50%)

  const arabicScore    = Math.min(40, (arabicWordCount / 40) * 40);
  const diversityScore = Math.min(30, uniqueWordRatio * 60);
  const patternScore   = Math.min(20, questionPatternCount * 5);
  const dotPenalty     = dotRatio > 0.5 ? -(dotRatio * 10) : 0;

  const score = Math.max(0, Math.min(100,
    arabicScore + diversityScore + patternScore + dotPenalty,
  ));

  // ── Reason string ─────────────────────────────────────────────────────────
  let reason: string;
  if (arabicWordCount < MIN_ARABIC_WORDS_FOR_GOOD) {
    reason = `too few Arabic words (${arabicWordCount} < ${MIN_ARABIC_WORDS_FOR_GOOD})`;
  } else if (uniqueWordRatio < 0.2) {
    reason = `repetitive content (uniqueWordRatio=${uniqueWordRatio.toFixed(2)})`;
  } else if (dotRatio > 0.5) {
    reason = `dot-heavy (${(dotRatio * 100).toFixed(0)}% dots)`;
  } else {
    reason = `composite score ${score.toFixed(0)}/100`;
  }

  const threshold = Number(process.env.OCR_QUALITY_MIN_SCORE ?? DEFAULT_MIN_QUALITY_SCORE);
  const isLowConfidence = score < threshold;

  return {
    arabicWordCount,
    uniqueWordRatio,
    questionPatternCount,
    dotRatio,
    totalChars,
    score,
    isLowConfidence,
    reason,
  };
}

// ─── Question pattern detector ────────────────────────────────────────────────

/**
 * Quick structural check: does the text contain recognizable question patterns?
 *
 * Used in questionExtractor to decide whether to force an extraction retry
 * before giving up on a chunk that returned 0 questions.
 */
export function detectQuestionPatterns(text: string): QuestionPatternDetection {
  const hasNumberedItems = NUMBERED_ITEM_RE.test(text);
  const hasQuestionWords = QUESTION_WORD_RE.test(text);
  const hasQuestionMarks = QUESTION_MARK_RE.test(text);
  const hasMcqOptions    = MCQ_OPTION_RE.test(text);

  const count = [hasNumberedItems, hasQuestionWords, hasQuestionMarks, hasMcqOptions]
    .filter(Boolean).length;

  return { count, hasNumberedItems, hasQuestionWords, hasQuestionMarks, hasMcqOptions };
}

// ─── Score threshold accessor ─────────────────────────────────────────────────

/** Returns the configured quality threshold (reads env var each call). */
export function getQualityThreshold(): number {
  return Number(process.env.OCR_QUALITY_MIN_SCORE ?? DEFAULT_MIN_QUALITY_SCORE);
}
