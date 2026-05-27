import type { CurriculumChunk } from '../data/curriculum/types';
import { getCurriculumChunks } from './curriculumStore';

export interface SearchResult {
  chunk: CurriculumChunk;
  score: number;
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2)
  );
}

function scoreChunk(chunk: CurriculumChunk, queryTokens: Set<string>): number {
  let score = 0;

  const contentTokens = tokenize(chunk.content);
  for (const qt of queryTokens) {
    if (contentTokens.has(qt)) score += 2;
    if (chunk.keywords.includes(qt)) score += 3;
    if (chunk.chapter.toLowerCase().includes(qt)) score += 5;
  }

  return score;
}

export function searchCurriculum(
  country: string,
  level: string,
  subject: string,
  query: string,
  topK = 3
): CurriculumChunk[] {
  if (!country || !level || !subject) return [];

  const chunks = getCurriculumChunks(country, level, subject);
  if (chunks.length === 0) return [];

  const queryTokens = tokenize(query);
  if (queryTokens.size === 0) return chunks.slice(0, topK);

  const scored: SearchResult[] = chunks
    .map((chunk) => ({ chunk, score: scoreChunk(chunk, queryTokens) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, topK).map((r) => r.chunk);
}

export function formatCurriculumContext(chunks: CurriculumChunk[]): string {
  if (chunks.length === 0) return '';

  const sections = chunks.map(
    (c) =>
      `--- [${c.chapter} | Pages ${c.pageRange}] ---\n${c.content.slice(0, 1500)}`
  );

  return `\n\n==================================================\nCURRICULUM REFERENCE MATERIAL\n==================================================\nThe following is extracted directly from the official textbook. Use it as your primary source:\n\n${sections.join('\n\n')}\n==================================================`;
}
