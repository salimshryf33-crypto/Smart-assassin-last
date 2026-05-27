import type { CurriculumChunk } from '../data/curriculum/types';

const CHAPTER_PATTERNS = [
  /^(الفصل|الباب|الوحدة|الدرس|Chapter|Unit|Lesson|Topic)\s+[\d\u0660-\u0669\u0041-\u005A]+/i,
  /^[\d]+[.\-\)]\s+.{3,}/,
  /^(مقدمة|خاتمة|تمهيد|مراجعة|Introduction|Summary|Review)/i,
];

function isChapterHeading(text: string): boolean {
  const t = text.trim();
  if (t.length < 3 || t.length > 120) return false;
  return CHAPTER_PATTERNS.some((p) => p.test(t));
}

function extractKeywords(text: string): string[] {
  const stopWords = new Set([
    'في', 'من', 'إلى', 'على', 'أن', 'هذا', 'هذه', 'التي', 'الذي', 'وهو',
    'كان', 'كانت', 'يكون', 'بين', 'حيث', 'ما', 'هو', 'هي', 'لا', 'عن',
    'مع', 'بعد', 'قبل', 'عند', 'كل', 'which', 'that', 'this', 'the', 'and',
    'of', 'to', 'a', 'in', 'is', 'are', 'was', 'for', 'with', 'as', 'by',
  ]);
  const words = text
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w.toLowerCase()));
  const freq: Record<string, number> = {};
  for (const w of words) {
    const k = w.toLowerCase();
    freq[k] = (freq[k] ?? 0) + 1;
  }
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([w]) => w);
}

function chunkPages(
  pages: string[],
  docId: string,
  country: string,
  grade: string,
  subject: string
): CurriculumChunk[] {
  const chunks: CurriculumChunk[] = [];
  const PAGES_PER_CHUNK = 6;
  let chunkIndex = 0;
  let currentChapter = 'General';

  for (let i = 0; i < pages.length; i += PAGES_PER_CHUNK) {
    const slice = pages.slice(i, i + PAGES_PER_CHUNK);
    const combinedText = slice.join('\n\n');

    const firstLines = combinedText.split('\n').slice(0, 5);
    const headingLine = firstLines.find(isChapterHeading);
    if (headingLine) {
      currentChapter = headingLine.trim().slice(0, 80);
    }

    const startPage = i + 1;
    const endPage = Math.min(i + PAGES_PER_CHUNK, pages.length);

    chunks.push({
      id: `${docId}-chunk-${chunkIndex++}`,
      country,
      grade,
      subject,
      chapter: currentChapter,
      pageRange: `${startPage}-${endPage}`,
      content: combinedText.slice(0, 6000),
      keywords: extractKeywords(combinedText),
    });
  }

  return chunks;
}

export interface ParseProgress {
  current: number;
  total: number;
}

export async function parsePDF(
  file: File,
  docId: string,
  country: string,
  grade: string,
  subject: string,
  onProgress?: (p: ParseProgress) => void
): Promise<{ chunks: CurriculumChunk[]; totalPages: number }> {
  const pdfjsLib = await import('pdfjs-dist');

  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.mjs',
    import.meta.url
  ).toString();

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const totalPages = pdf.numPages;
  const pageTexts: string[] = [];

  for (let p = 1; p <= totalPages; p++) {
    onProgress?.({ current: p, total: totalPages });
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    pageTexts.push(text);
  }

  const chunks = chunkPages(pageTexts, docId, country, grade, subject);
  return { chunks, totalPages };
}
