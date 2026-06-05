import { v4 as uuidv4 } from 'uuid';
import type { CurriculumChunk } from './curriculumStorage';
import { normalizeArabic, tokenize } from './curriculumStorage';

const CHAPTER_PATTERNS = [
  /^(الفصل|الباب|الوحدة|الدرس|Chapter|Unit|Lesson|Topic|الموضوع|المحور)\s+[\d\u0660-\u0669A-Z]+/i,
  /^[\d]+[.\-\)]\s+.{4,}/,
  /^(مقدمة|خاتمة|تمهيد|مراجعة|Introduction|Summary|Review|تلخيص|أهداف)/i,
];

function isChapterHeading(text: string): boolean {
  const t = text.trim();
  if (t.length < 3 || t.length > 120) return false;
  return CHAPTER_PATTERNS.some((p) => p.test(t));
}

function extractKeywords(text: string): string[] {
  const freq: Record<string, number> = {};
  tokenize(text).forEach((w) => {
    freq[w] = (freq[w] ?? 0) + 1;
  });
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)
    .map(([w]) => w);
}

interface ChunkMeta {
  docId: string;
  country: string;
  grade: string;
  subject: string;
}

// 4 pages per chunk — fine-grained enough for topic-level retrieval
const PAGES_PER_CHUNK = 4;

// Maximum chars per stored chunk.
// When a page-group exceeds this limit the text is SPLIT into sub-chunks
// (not truncated) so no content is ever lost.
const MAX_CHUNK_CHARS = 5000;

/**
 * Split a long text into sub-chunks of at most MAX_CHUNK_CHARS each,
 * breaking at word boundaries where possible.
 */
function splitIntoSubChunks(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];

  const parts: string[] = [];
  let pos = 0;

  while (pos < text.length) {
    let end = Math.min(pos + maxChars, text.length);

    // Try to break at whitespace so we don't cut mid-word
    if (end < text.length) {
      const spaceIdx = text.lastIndexOf(' ', end);
      if (spaceIdx > pos + maxChars / 2) end = spaceIdx + 1;
    }

    const slice = text.slice(pos, end).trim();
    if (slice.length > 0) parts.push(slice);
    pos = end;
  }

  return parts;
}

export function chunkText(pageTexts: string[], meta: ChunkMeta): CurriculumChunk[] {
  const chunks: CurriculumChunk[] = [];
  let currentChapter = 'عام';
  let chunkIndex = 0;

  for (let i = 0; i < pageTexts.length; i += PAGES_PER_CHUNK) {
    const slice = pageTexts.slice(i, i + PAGES_PER_CHUNK);
    const combined = slice.join('\n\n');

    // Detect chapter heading from first lines of this slice
    const firstLines = combined.split('\n').slice(0, 8);
    const heading = firstLines.find(isChapterHeading);
    if (heading) currentChapter = heading.trim().slice(0, 100);

    const startPage = i + 1;
    const endPage = Math.min(i + PAGES_PER_CHUNK, pageTexts.length);

    // Keywords are extracted from the FULL combined text regardless of how
    // many sub-chunks it gets split into — gives every sub-chunk the full
    // topic signal from the original page group.
    const keywords = extractKeywords(combined);

    // SPLIT instead of truncate: all content is preserved
    const subChunks = splitIntoSubChunks(combined, MAX_CHUNK_CHARS);

    for (const content of subChunks) {
      chunks.push({
        id: uuidv4(),
        docId: meta.docId,
        country: meta.country,
        grade: meta.grade,
        subject: meta.subject,
        chapter: currentChapter,
        pageRange: `${startPage}-${endPage}`,
        chunkIndex: chunkIndex++,
        content,
        contentNormalized: normalizeArabic(content),
        keywords,
      });
    }
  }

  return chunks;
}
