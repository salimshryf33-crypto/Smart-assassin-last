import { v4 as uuidv4 } from 'uuid';
import type { CurriculumChunk } from './curriculumStorage';
import { normalizeArabic } from './curriculumStorage';

const CHAPTER_PATTERNS = [
  /^(الفصل|الباب|الوحدة|الدرس|Chapter|Unit|Lesson|Topic|الموضوع|المحور)\s+[\d\u0660-\u0669A-Z]+/i,
  /^[\d]+[.\-\)]\s+.{4,}/,
  /^(مقدمة|خاتمة|تمهيد|مراجعة|Introduction|Summary|Review|تلخيص|أهداف)/i,
];

const STOP_WORDS_CHUNK = new Set([
  'في', 'من', 'إلى', 'على', 'أن', 'هذا', 'هذه', 'التي', 'الذي', 'وهو',
  'كان', 'كانت', 'يكون', 'بين', 'حيث', 'ما', 'هو', 'هي', 'لا', 'عن',
  'مع', 'بعد', 'قبل', 'عند', 'كل', 'ذلك', 'تلك', 'هناك', 'وقد', 'قد',
  'which', 'that', 'this', 'the', 'and', 'of', 'to', 'a', 'in', 'is',
  'are', 'was', 'for', 'with', 'as', 'by', 'at', 'or', 'it',
]);

function isChapterHeading(text: string): boolean {
  const t = text.trim();
  if (t.length < 3 || t.length > 120) return false;
  return CHAPTER_PATTERNS.some((p) => p.test(t));
}

function extractKeywords(text: string): string[] {
  const freq: Record<string, number> = {};
  text
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .forEach((w) => {
      // Normalize before storing so keyword matching works after normalization
      const k = normalizeArabic(w);
      if (k.length > 2 && !STOP_WORDS_CHUNK.has(k) && !STOP_WORDS_CHUNK.has(w.toLowerCase())) {
        freq[k] = (freq[k] ?? 0) + 1;
      }
    });
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)  // More keywords for better coverage
    .map(([w]) => w);
}

interface ChunkMeta {
  docId: string;
  country: string;
  grade: string;
  subject: string;
}

// Smaller chunks = better retrieval precision
const PAGES_PER_CHUNK = 4;
const MAX_CHUNK_CHARS = 5000;

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

    // Store full content up to limit (no mid-word truncation)
    const content = combined.length > MAX_CHUNK_CHARS
      ? combined.slice(0, MAX_CHUNK_CHARS).replace(/\s+\S*$/, '') // trim to last full word
      : combined;

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
      keywords: extractKeywords(combined),  // Extract from full combined (not truncated)
    });
  }

  return chunks;
}
