/**
 * coverageAnalyzer — Phase 1 (Coverage Engine) + Phase 6 (Extraction Score)
 *
 * ARCHITECTURE RULE: Read-only analysis layer. Never modifies questions or DB.
 * All functions are pure and side-effect free.
 *
 * Phase 1 — Coverage Engine:
 *   Compares OCR text volume, detected patterns, and extracted question count.
 *   Flags LOW_EXTRACTION_COVERAGE when extraction is suspiciously low.
 *
 * Phase 6 — Extraction Score:
 *   Produces a 0-100 composite score stored in ocrDiagnostics (JSONB).
 *   Factors: OCR quality + coverage + chunk success + dedup cleanliness + recovery.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type CoverageFlag = 'OK' | 'LOW_EXTRACTION_COVERAGE' | 'EMPTY_DOCUMENT';

export interface ChunkCoverageResult {
  arabicWords: number;
  patterns: number;
  extracted: number;
  expectedMin: number;
  flag: CoverageFlag;
}

export interface CoverageReport {
  totalWords: number;
  totalPatterns: number;
  expectedMinQuestions: number;
  extractedCount: number;
  coverageRatio: number;        // extracted / expectedMin (clamped 0-1 when expected > 0)
  flag: CoverageFlag;
  suspiciousChunkIndices: number[];
  diagnosis: string;
}

export interface ExtractionScoreBreakdown {
  ocrQuality: number;    // 0-30
  coverage: number;      // 0-30
  chunkSuccess: number;  // 0-20
  dedup: number;         // 0-10
  recovery: number;      // 0-10
}

export interface ExtractionScore {
  total: number;         // 0-100
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  breakdown: ExtractionScoreBreakdown;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Expected questions per detected question-pattern signal (conservative). */
const QUESTIONS_PER_PATTERN = 2;

/** Min Arabic words in a chunk before we expect at least one question. */
const MIN_WORDS_FOR_QUESTION = 20;

/** Coverage ratio below which we flag LOW_EXTRACTION_COVERAGE. */
const LOW_COVERAGE_THRESHOLD = 0.40;

// ─── Phase 1: Per-chunk coverage analysis ────────────────────────────────────

/**
 * Analyse coverage for a single chunk.
 * Called during extraction to decide whether to trigger a second pass.
 */
export function analyzeChunkCoverage(
  arabicWords: number,
  patterns: number,
  extracted: number,
): ChunkCoverageResult {
  const expectedMin = Math.max(1, patterns * QUESTIONS_PER_PATTERN);

  if (arabicWords < MIN_WORDS_FOR_QUESTION) {
    return { arabicWords, patterns, extracted, expectedMin: 0, flag: 'OK' };
  }

  if (arabicWords === 0 && patterns === 0) {
    return { arabicWords, patterns, extracted, expectedMin: 0, flag: 'EMPTY_DOCUMENT' };
  }

  const flag: CoverageFlag =
    patterns >= 1 && extracted === 0                          ? 'LOW_EXTRACTION_COVERAGE' :
    patterns >= 2 && extracted < expectedMin * LOW_COVERAGE_THRESHOLD ? 'LOW_EXTRACTION_COVERAGE' :
    'OK';

  return { arabicWords, patterns, extracted, expectedMin, flag };
}

// ─── Phase 1: Whole-exam coverage analysis ───────────────────────────────────

export interface ChunkDiagEntry {
  chunkIndex: number;
  arabicWords: number;
  questionPatterns: number;
  extracted: number;
  retried: boolean;
}

/**
 * Analyse coverage for the full exam after extraction completes.
 * Returns a CoverageReport with a flag and a human-readable diagnosis.
 */
export function analyzeCoverage(
  diagnostics: ChunkDiagEntry[],
  extractedCount: number,
): CoverageReport {
  const totalWords    = diagnostics.reduce((s, c) => s + c.arabicWords, 0);
  const totalPatterns = diagnostics.reduce((s, c) => s + c.questionPatterns, 0);

  if (totalWords === 0) {
    return {
      totalWords: 0, totalPatterns: 0, expectedMinQuestions: 0,
      extractedCount: 0, coverageRatio: 0, flag: 'EMPTY_DOCUMENT',
      suspiciousChunkIndices: [], diagnosis: 'No Arabic text detected in any chunk.',
    };
  }

  const expectedMinQuestions = Math.max(
    totalPatterns * QUESTIONS_PER_PATTERN,
    Math.floor(totalWords / 150),   // rough: 1 question per 150 Arabic words
  );

  const coverageRatio =
    expectedMinQuestions > 0
      ? Math.min(1, extractedCount / expectedMinQuestions)
      : 1;

  const suspiciousChunkIndices = diagnostics
    .filter(c => {
      if (c.arabicWords < MIN_WORDS_FOR_QUESTION) return false;
      if (c.questionPatterns === 0) return false;
      return c.extracted === 0;
    })
    .map(c => c.chunkIndex);

  const flag: CoverageFlag =
    extractedCount === 0 && totalWords > 0
      ? 'LOW_EXTRACTION_COVERAGE'
      : coverageRatio < LOW_COVERAGE_THRESHOLD && totalPatterns >= 2
      ? 'LOW_EXTRACTION_COVERAGE'
      : 'OK';

  // Note: 'EMPTY_DOCUMENT' is handled by the early-return above (totalWords === 0).
  // At this point flag is guaranteed to be 'OK' | 'LOW_EXTRACTION_COVERAGE'.
  const diagnosis =
    flag === 'LOW_EXTRACTION_COVERAGE'
      ? `Low extraction coverage: got ${extractedCount} questions, expected ≥${expectedMinQuestions} ` +
        `from ${totalPatterns} patterns and ${totalWords} Arabic words. ` +
        (suspiciousChunkIndices.length > 0
          ? `Suspicious chunks: ${suspiciousChunkIndices.join(', ')}.`
          : '')
      : `Coverage OK: ${extractedCount} questions from ${totalPatterns} patterns (ratio ${(coverageRatio * 100).toFixed(0)}%).`;

  return {
    totalWords, totalPatterns, expectedMinQuestions,
    extractedCount, coverageRatio, flag,
    suspiciousChunkIndices, diagnosis,
  };
}

// ─── Phase 6: Extraction Score ────────────────────────────────────────────────

export interface ExtractionScoreParams {
  ocrQualityScore: number;       // 0-100
  coverageRatio: number;         // 0-1
  successfulChunks: number;      // chunks that produced ≥1 question
  totalChunks: number;
  exactRemoved: number;          // exact duplicates removed
  nearRemoved: number;           // near-duplicates removed
  totalExtracted: number;        // questions before dedup
  recoveredChunks: number;       // chunks saved by retry
}

/** Compute a 0-100 extraction quality score and letter grade. */
export function computeExtractionScore(p: ExtractionScoreParams): ExtractionScore {
  // 30 pts — OCR quality
  const ocrQuality = Math.round((p.ocrQualityScore / 100) * 30);

  // 30 pts — coverage ratio
  const coverage = Math.round(p.coverageRatio * 30);

  // 20 pts — chunk success rate
  const chunkSuccessRate = p.totalChunks > 0 ? p.successfulChunks / p.totalChunks : 1;
  const chunkSuccess = Math.round(chunkSuccessRate * 20);

  // 10 pts — dedup cleanliness (fewer duplicates = better)
  const totalExtracted = Math.max(1, p.totalExtracted);
  const dupRatio = (p.exactRemoved + p.nearRemoved) / totalExtracted;
  const dedup = Math.round(Math.max(0, 10 - dupRatio * 20));

  // 10 pts — recovery bonus (chunks rescued by retry)
  const recoveryRate = p.totalChunks > 0 ? p.recoveredChunks / p.totalChunks : 0;
  const recovery = Math.round(recoveryRate * 10);

  const total = Math.min(100, ocrQuality + coverage + chunkSuccess + dedup + recovery);

  const grade: ExtractionScore['grade'] =
    total >= 90 ? 'A' :
    total >= 75 ? 'B' :
    total >= 60 ? 'C' :
    total >= 40 ? 'D' : 'F';

  return { total, grade, breakdown: { ocrQuality, coverage, chunkSuccess, dedup, recovery } };
}
