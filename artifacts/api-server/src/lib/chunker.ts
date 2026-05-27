import { v4 as uuidv4 } from 'uuid';
import type { CurriculumChunk } from './curriculumStorage';

const CHAPTER_PATTERNS = [
  /^(الفصل|الباب|الوحدة|الدرس|Chapter|Unit|Lesson|Topic)\s+[\d\u0660-\u0669A-Z]+/i,
  /^[\d]+[.\-\)]\s+.{4,}/,
  /^(مقدمة|خاتمة|تمهيد|مراجعة|Introduction|Summary|Review)/i,
];

const STOP_WORDS = new Set([
  'في', 'من', 'إلى', 'على', 'أن', 'هذا', 'هذه', 'التي', 'الذي', 'وهو',
  'كان', 'كانت', 'يكون', 'بين', 'حيث', 'ما', 'هو', 'هي', 'لا', 'عن',
  'مع', 'بعد', 'قبل', 'عند', 'كل', 'which', 'that', 'this', 'the', 'and',
  'of', 'to', 'a', 'in', 'is', 'are', 'was', 'for', 'with', 'as', 'by',
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
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w.toLowerCase()))
    .forEach((w) => {
      const k = w.toLowerCase();
      freq[k] = (freq[k] ?? 0) + 1;
    });
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([w]) => w);
}

interface ChunkMeta {
  docId: string;
  country: string;
  grade: string;
  subject: string;
}

const PAGES_PER_CHUNK = 6;
const MAX_CHUNK_CHARS = 6000;

export function chunkText(pageTexts: string[], meta: ChunkMeta): CurriculumChunk[] {
  const chunks: CurriculumChunk[] = [];
  let currentChapter = 'General';
  let chunkIndex = 0;

  for (let i = 0; i < pageTexts.length; i += PAGES_PER_CHUNK) {
    const slice = pageTexts.slice(i, i + PAGES_PER_CHUNK);
    const combined = slice.join('\n\n');

    // Detect chapter heading from first lines of this slice
    const firstLines = combined.split('\n').slice(0, 6);
    const heading = firstLines.find(isChapterHeading);
    if (heading) currentChapter = heading.trim().slice(0, 80);

    const startPage = i + 1;
    const endPage = Math.min(i + PAGES_PER_CHUNK, pageTexts.length);

    chunks.push({
      id: uuidv4(),
      docId: meta.docId,
      country: meta.country,
      grade: meta.grade,
      subject: meta.subject,
      chapter: currentChapter,
      pageRange: `${startPage}-${endPage}`,
      chunkIndex: chunkIndex++,
      content: combined.slice(0, MAX_CHUNK_CHARS),
      keywords: extractKeywords(combined),
    });
  }

  return chunks;
}
