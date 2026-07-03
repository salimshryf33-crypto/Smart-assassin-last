/**
 * correctionEngine/evidenceRetriever.ts
 *
 * Stage 1 — RETRIEVE: Responsible ONLY for retrieving curriculum evidence.
 * Stage 2 — VALIDATE: Provides validateEvidence() to confirm evidence quality
 *   before the Correction Package is built.
 *
 * Key behaviours:
 *  - Per-attempt in-memory cache: identical queries are never fetched twice.
 *  - Graceful embedding fallback: semantic scoring used when available, else
 *    keyword-only — never throws.
 *  - Scope filtering: if ResolvedCurriculum carries a docId (Phase 2), only
 *    chunks from that document are returned.
 *
 * Stage 2 validation checks (in order):
 *  1. Chunk count   — at least 1 chunk must be retrieved
 *  2. Confidence    — at least 1/topK normalised confidence score
 *  3. Relevance     — at least one chunk must share significant keywords
 *                     with the question (prevents irrelevant cross-topic matches)
 */

import { searchChunks }   from '../curriculumStorage';
import { getEmbedding }   from '../embeddingService';
import { logger }         from '../logger';
import type {
  CurriculumEvidence,
  EvidenceChunk,
  EvidenceValidation,
  QuestionCorrectionInput,
} from './types';
import type { ResolvedCurriculum } from './curriculumResolver';

const EVIDENCE_TOP_K           = 6;
const MIN_CONFIDENCE_THRESHOLD = 1 / EVIDENCE_TOP_K; // at least 1 chunk
/** Minimum keyword length to be considered significant for relevance checking. */
const MIN_KEYWORD_LENGTH       = 3;
/** Minimum number of shared keywords required for a chunk to be considered relevant. */
const MIN_SHARED_KEYWORDS      = 1;

// ─── EvidenceRetriever ────────────────────────────────────────────────────────

export class EvidenceRetriever {
  /**
   * Per-attempt cache: cacheKey → evidence.
   * Prevents redundant RAG calls when multiple questions share the same
   * topic/chapter within an exam.
   */
  private readonly cache = new Map<string, CurriculumEvidence>();

  /**
   * Stage 1 — RETRIEVE curriculum evidence for one question.
   * Called once per question; returns cached result on repeated queries.
   */
  async retrieve(
    question:   QuestionCorrectionInput,
    curriculum: ResolvedCurriculum
  ): Promise<CurriculumEvidence> {
    const query    = this.buildQuery(question);
    const cacheKey = this.buildCacheKey(curriculum, query);

    const hit = this.cache.get(cacheKey);
    if (hit) {
      logger.debug({ cacheKey }, 'evidenceRetriever: cache hit');
      return hit;
    }

    const evidence = await this.fetchEvidence(query, curriculum);
    this.cache.set(cacheKey, evidence);
    return evidence;
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private buildQuery(q: QuestionCorrectionInput): string {
    const parts: string[] = [q.question];
    if (q.topic)   parts.push(q.topic);
    if (q.chapter) parts.push(q.chapter);
    return parts.join(' ').slice(0, 800); // cap query length
  }

  private buildCacheKey(curriculum: ResolvedCurriculum, query: string): string {
    const { country, grade, subject, docId } = curriculum.filters;
    return `${country}:${grade}:${subject}:${docId ?? '*'}:${query}`;
  }

  private async fetchEvidence(
    query:      string,
    curriculum: ResolvedCurriculum
  ): Promise<CurriculumEvidence> {
    const { country, grade, subject, docId } = curriculum.filters;

    // Attempt semantic embedding for hybrid scoring (never throws)
    let queryEmbedding: number[] | undefined;
    try {
      queryEmbedding = await getEmbedding(query);
    } catch (err) {
      logger.debug({ err }, 'evidenceRetriever: embedding unavailable — keyword-only search');
    }

    // When docId is set (Phase 2 — linked curriculum), it is passed directly
    // into searchChunks opts so the document filter runs BEFORE topK ranking.
    // searchChunks will load and score ONLY chunks from that document.
    // Post-retrieval docId filtering is intentionally absent: the linked
    // document is the exclusive search scope, not a post-hoc narrowing step.
    const chunks_raw = searchChunks(
      country,
      grade,
      subject,
      query,
      EVIDENCE_TOP_K,
      { queryEmbedding, ...(docId ? { docId } : {}) }
    );

    const confidence = chunks_raw.length > 0
      ? Math.min(1, chunks_raw.length / EVIDENCE_TOP_K)
      : 0;

    const chunks: EvidenceChunk[] = chunks_raw.map((c) => ({
      id:        c.id,
      docId:     c.docId,
      chapter:   c.chapter,
      pageRange: c.pageRange,
      // Cap content per chunk to control token usage
      content:   c.content.slice(0, 1200),
    }));

    logger.debug(
      {
        query:              query.slice(0, 60),
        country, grade, subject,
        docId:              docId ?? '* (subject-wide)',
        chunksFound:        chunks.length,
        confidence:         confidence.toFixed(2),
        strategy:           curriculum.strategy,
      },
      'evidenceRetriever: Stage 1 retrieval complete'
    );

    return {
      chunks,
      confidence,
      strategy:            curriculum.strategy,
      totalChunksSearched: chunks_raw.length,
    };
  }

  // ─── Stage 2: Validate ─────────────────────────────────────────────────────

  /**
   * Stage 2 — VALIDATE retrieved evidence before building the Correction Package.
   *
   * Three-layer validation:
   *  1. Chunk presence   — at least one chunk must exist
   *  2. Confidence floor — normalised confidence must meet minimum threshold
   *  3. Keyword relevance — at least one chunk must share significant words
   *                         with the question text (prevents topic mismatch)
   *
   * Returns EvidenceValidation with isValid flag and machine/human reason.
   * The grader calls this; the retriever stays focused on retrieval.
   */
  static validateEvidence(
    evidence: CurriculumEvidence,
    questionText: string
  ): EvidenceValidation {
    // Check 1: chunk presence
    if (evidence.chunks.length === 0) {
      return {
        isValid: false,
        reason:  'no_chunks',
        message: 'لا توجد أدلة منهجية مسترجعة لهذا السؤال.',
      };
    }

    // Check 2: confidence floor
    if (evidence.confidence < MIN_CONFIDENCE_THRESHOLD) {
      return {
        isValid: false,
        reason:  'low_confidence',
        message: `ثقة الأدلة المنهجية منخفضة (${(evidence.confidence * 100).toFixed(0)}%).`,
      };
    }

    // Check 3: keyword relevance
    // Extract significant keywords from the question (length > MIN_KEYWORD_LENGTH,
    // excluding common stopwords)
    const ARABIC_STOPWORDS = new Set([
      'من', 'في', 'على', 'إلى', 'عن', 'مع', 'هو', 'هي', 'هم', 'ما', 'لا',
      'أن', 'إن', 'كان', 'يكون', 'هذا', 'هذه', 'التي', 'الذي', 'وهو',
      'the', 'is', 'are', 'was', 'what', 'how', 'why', 'which', 'that',
    ]);

    const questionKeywords = questionText
      .split(/\s+/)
      .map((w) => w.replace(/[^\u0600-\u06FF\w]/g, '').toLowerCase())
      .filter((w) => w.length > MIN_KEYWORD_LENGTH && !ARABIC_STOPWORDS.has(w));

    if (questionKeywords.length > 0) {
      const hasRelevantChunk = evidence.chunks.some((chunk) => {
        const chunkLower = chunk.content.toLowerCase();
        const sharedCount = questionKeywords.filter((kw) =>
          chunkLower.includes(kw)
        ).length;
        return sharedCount >= MIN_SHARED_KEYWORDS;
      });

      if (!hasRelevantChunk) {
        return {
          isValid: false,
          reason:  'irrelevant_chunks',
          message: 'الأدلة المسترجعة لا تتعلق بموضوع السؤال بشكل مباشر.',
        };
      }
    }

    return { isValid: true };
  }

  /**
   * Quick boolean check used by callers that only need pass/fail.
   * @deprecated Use validateEvidence() for detailed validation with reasons.
   */
  static isSufficient(evidence: CurriculumEvidence): boolean {
    return (
      evidence.chunks.length > 0 &&
      evidence.confidence >= MIN_CONFIDENCE_THRESHOLD
    );
  }
}
