import { v4 as uuidv4 } from 'uuid';
import type { CurriculumChunk } from './curriculumStorage';
import { normalizeArabic, tokenize } from './curriculumStorage';

// ─── Chapter Detection ────────────────────────────────────────────────────────
//
// Two-level detection:
//   1. isChapterHeading(line)   — strict LINE-START match, used during chunking
//   2. extractChapterLabel(text) — broader scan of all lines (including embedded
//      headings like "X الأحياء - ثالث ثانوي ب الوحدة الأولى ..."), used during
//      relabeling of existing OCR chunks where the page-number / book-title
//      prefix often appears on the same line as the structural heading.

const ARABIC_ORDINALS_SRC =
  'الأول|الثاني|الثالث|الرابع|الخامس|السادس|السابع|الثامن|التاسع|العاشر|' +
  'الأولى|الثانية|الثالثة|الرابعة|الخامسة|السادسة|السابعة|الثامنة|التاسعة|العاشرة';

const STRUCTURAL_KEYWORDS_SRC =
  'الفصل|الباب|الوحدة|الدرس|الموضوع|المحور|الجزء|القسم|الفقرة|المحاضرة';

// ── Strict line-start patterns ────────────────────────────────────────────────
// Applied to trimmed lines to detect headings when chunking fresh OCR output.
// Intentionally excludes numbered-list patterns (1- 2. 3)) which cause too many
// false positives with MCQ exam content.
const CHAPTER_PATTERNS: RegExp[] = [
  // "الفصل 1", "الباب 2", "الوحدة 3" — numeric
  /^(الفصل|الباب|الوحدة|الدرس|Chapter|Unit|Lesson|Topic|الموضوع|المحور|الجزء|القسم)\s+[\d\u0660-\u0669A-Z]+/i,

  // "الباب الأول", "الفصل الثاني", "الوحدة الثالثة" — word ordinals
  new RegExp(`^(${STRUCTURAL_KEYWORDS_SRC})\\s+(${ARABIC_ORDINALS_SRC})`, 'i'),

  // "أولاً:", "ثانياً -" etc. — section adverbials, short heading only
  /^(أولاً|ثانياً|ثالثاً|رابعاً|خامساً|سادساً|سابعاً|ثامناً|تاسعاً|عاشراً)\s*[:\-–—]\s*.{3,60}$/i,

  // Intro / summary / goals sections
  /^(مقدمة|خاتمة|تمهيد|مراجعة|ملخص|تلخيص|أهداف|الأهداف|نتائج|Introduction|Summary|Review|Conclusion|Objectives)\b/i,

  // Common standalone physics/bio/science chapter labels.
  // Only match SHORT lines (≤ 35 chars): "الموجات", "الضوء", "الحركة"
  // Requires optional colon/dash OR nothing after the subject word.
  // This prevents matching prose sentences like "الطاقة هي المقدرة على إنجاز الشغل".
  /^(الكهرباء|الضوء|الحرارة|الموجات|المغناطيسية|الميكانيكا|الديناميكا|الإلكترونيات|الطاقة|القوى|الجاذبية|الصوت|الحركة|الضغط|البصريات|النووية|الكيمياء|التركيب|الجهاز|الهضم|التكاثر|الوراثة|التطور)\s*([:\-–—]\s*.{3,30})?$/i,
];

// ── Embedded heading pattern (looser, for OCR output with noise) ─────────────
// Matches structural keyword + ordinal ANYWHERE within a line.
// Used when the line begins with page-number or book-title prefix.
const EMBEDDED_CHAPTER_RE = new RegExp(
  `(${STRUCTURAL_KEYWORDS_SRC})\\s+(${ARABIC_ORDINALS_SRC})[^،.\\n]{0,60}`,
  'i'
);

export function isChapterHeading(text: string): boolean {
  const t = text.trim();
  // Max 100 chars prevents matching full sentences; min 3 prevents empty noise
  if (t.length < 3 || t.length > 100) return false;
  return CHAPTER_PATTERNS.some((p) => p.test(t));
}

/**
 * Scan all lines of `text` for a chapter heading (both strict line-start AND
 * embedded patterns). Returns the canonical heading string or null.
 *
 * Priority: strict line-start patterns come first (highest confidence).
 * Falls back to embedded patterns for OCR text where book-title / page-number
 * prefixes appear before the structural keyword on the same line.
 */
export function extractChapterLabel(text: string): string | null {
  const lines = text.split('\n');

  // Pass 1 — strict line-start match (high confidence)
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (isChapterHeading(line)) return line.slice(0, 80);
  }

  // Pass 2 — embedded match (handles OCR prefix noise)
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.length > 300) continue; // skip very long lines

    const m = line.match(EMBEDDED_CHAPTER_RE);
    if (m) {
      const extracted = m[0].trim().slice(0, 80);
      // Sanity check: result should look like a heading not a prose sentence
      if (extracted.length >= 5 && extracted.length <= 80) return extracted;
    }
  }

  return null;
}

// ─── Keyword Extraction ───────────────────────────────────────────────────────

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

// ─── Chunker ──────────────────────────────────────────────────────────────────

interface ChunkMeta {
  docId: string;
  country: string;
  grade: string;
  subject: string;
}

const PAGES_PER_CHUNK = 4;
const MAX_CHUNK_CHARS = 5000;

function splitIntoSubChunks(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const parts: string[] = [];
  let pos = 0;
  while (pos < text.length) {
    let end = Math.min(pos + maxChars, text.length);
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

    // Use full extractChapterLabel (both strict + embedded) for incoming pages
    const detected = extractChapterLabel(combined);
    if (detected) currentChapter = detected;

    const startPage = i + 1;
    const endPage = Math.min(i + PAGES_PER_CHUNK, pageTexts.length);
    const keywords = extractKeywords(combined);
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
