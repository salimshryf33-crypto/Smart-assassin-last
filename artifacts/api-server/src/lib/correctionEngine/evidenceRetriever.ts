/**
 * correctionEngine/evidenceRetriever.ts
 *
 * Responsible ONLY for retrieving curriculum evidence for a question.
 * Uses the hybrid searchChunks() engine (keyword + trigram + semantic).
 *
 * Key behaviours:
 *  - Per-attempt in-memory cache: identical queries are never fetched twice.
 *  - Graceful embedding fallback: semantic scoring used when available, else
 *    keyword-only — never throws.
 *  - Scope filtering: if ResolvedCurriculum carries a docId (Phase 2), only
 *    chunks from that document are returned.
 */

import { searchChunks }   from '../curriculumStorage';
import { getEmbedding }   from '../embeddingService';
import { logger }         from '../logger';
import type { CurriculumEvidence, EvidenceChunk, QuestionCorrectionInput } from './types';
import type { ResolvedCurriculum } from './curriculumResolver';

const EVIDENCE_TOP_K          = 6;
const MIN_CONFIDENCE_THRESHOLD = 1 / EVIDENCE_TOP_K; // at least 1 chunk

// ─── EvidenceRetriever ────────────────────────────────────────────────────────

export class EvidenceRetriever {
  /**
   * Per-attempt cache: cacheKey → evidence.
   * Prevents redundant RAG calls when multiple questions share the same
   * topic/chapter within an exam.
   */
  private readonly cache = new Map<string, CurriculumEvidence>();

  /**
   * Retrieve curriculum evidence for one question.
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

    const rawChunks = searchChunks(
      country,
      grade,
      subject,
      query,
      EVIDENCE_TOP_K,
      { queryEmbedding }
    );

    // Phase 2: if a specific docId is linked, restrict to that document only
    const filteredChunks = docId
      ? rawChunks.filter((c) => c.docId === docId)
      : rawChunks;

    const confidence = filteredChunks.length > 0
      ? Math.min(1, filteredChunks.length / EVIDENCE_TOP_K)
      : 0;

    const chunks: EvidenceChunk[] = filteredChunks.map((c) => ({
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
        country, grade, subject, docId,
        chunksFound:        chunks.length,
        confidence:         confidence.toFixed(2),
        strategy:           curriculum.strategy,
      },
      'evidenceRetriever: evidence retrieved'
    );

    return {
      chunks,
      confidence,
      strategy:            curriculum.strategy,
      totalChunksSearched: rawChunks.length,
    };
  }

  /** Whether the retrieved evidence meets the minimum threshold for AI grading. */
  static isSufficient(evidence: CurriculumEvidence): boolean {
    return (
      evidence.chunks.length > 0 &&
      evidence.confidence >= MIN_CONFIDENCE_THRESHOLD
    );
  }
}
