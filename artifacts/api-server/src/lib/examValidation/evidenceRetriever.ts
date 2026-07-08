/**
 * examValidation/evidenceRetriever.ts
 *
 * Wraps the existing Hybrid RAG search to retrieve curriculum evidence for a
 * given exam question.
 *
 * Responsibilities:
 *   - Call searchChunks() with the question text as the query
 *   - Constrain retrieval to the question's own subject / grade / country
 *   - Classify the result as SUFFICIENT, LOW, or NONE
 *   - Return a structured EvidenceResult safe for storage in JSONB columns
 *
 * NO writes — pure retrieval.
 */

import { searchChunks }         from '../curriculumStorage';
import type { CurriculumChunk } from '../curriculumStorage';
import type { PipelineQuestion, EvidenceResult, EvidenceChunk } from './types';

// Minimum number of chunks to consider evidence SUFFICIENT
const MIN_CHUNKS_SUFFICIENT = 2;

// How many top chunks to retrieve from RAG
const TOP_K = 10;

// Maximum character length per chunk sent to Gemini
// (keeps prompt size manageable while preserving context)
const MAX_CHUNK_CHARS = 1_500;

// ─── Public API ───────────────────────────────────────────────────────────────

export function retrieveEvidence(question: PipelineQuestion): EvidenceResult {
  const rawChunks: CurriculumChunk[] = searchChunks(
    question.country,
    question.grade,
    question.subject,
    question.question,
    TOP_K,
  );

  if (rawChunks.length === 0) {
    return {
      topChunks:       [],
      chunkIds:        [],
      pages:           [],
      retrievalScore:  0,
      retrievalStatus: 'NONE',
    };
  }

  const topChunks: EvidenceChunk[] = rawChunks.map((c) => ({
    id:        c.id,
    content:   c.content.slice(0, MAX_CHUNK_CHARS),
    chapter:   c.chapter,
    pageRange: c.pageRange,
  }));

  const chunkIds = topChunks.map((c) => c.id);
  const pages    = topChunks.map((c) => c.pageRange).filter(Boolean);

  // Normalised retrieval score: fraction of TOP_K slots filled
  const retrievalScore = Math.min(rawChunks.length / TOP_K, 1);

  const retrievalStatus =
    rawChunks.length >= MIN_CHUNKS_SUFFICIENT ? 'SUFFICIENT' : 'LOW';

  return { topChunks, chunkIds, pages, retrievalScore, retrievalStatus };
}
