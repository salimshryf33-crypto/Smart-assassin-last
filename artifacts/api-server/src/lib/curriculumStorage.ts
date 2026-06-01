import fs from 'node:fs';
import path from 'node:path';
import { logger } from './logger';

export interface CurriculumChunk {
  id: string;
  docId: string;
  country: string;
  grade: string;
  subject: string;
  chapter: string;
  pageRange: string;
  chunkIndex: number;
  content: string;
  contentNormalized: string; // pre-computed for fast Arabic search
  keywords: string[];
  embedding?: number[];
}

export interface CurriculumDocument {
  id: string;
  country: string;
  grade: string;
  subject: string;
  track: string;
  filename: string;
  totalPages: number;
  chunkCount: number;
  status: 'queued' | 'processing' | 'done' | 'error';
  errorMessage?: string;
  uploadedAt: number;
  processedAt?: number;
}

const DATA_DIR = path.join(process.cwd(), 'data', 'curriculum');
const DOCS_DIR = path.join(DATA_DIR, 'docs');
const INDEX_FILE = path.join(DATA_DIR, 'index.json');

function ensureDirs() {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
}

// ─── In-memory chunk cache ────────────────────────────────────────────────────
// Caches loaded chunks per docId. Invalidated explicitly after every saveChunks.
const _chunkCache = new Map<string, CurriculumChunk[]>();

/**
 * Invalidate cached chunks for a specific document (or all docs if no id given).
 * Called by curriculumQueue after saveChunks so searches always see fresh data.
 */
export function invalidateChunkCache(docId?: string) {
  if (docId) {
    _chunkCache.delete(docId);
  } else {
    _chunkCache.clear();
  }
}

// ─── Index helpers ────────────────────────────────────────────────────────────

export function readIndex(): CurriculumDocument[] {
  ensureDirs();
  try {
    if (!fs.existsSync(INDEX_FILE)) return [];
    return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')) as CurriculumDocument[];
  } catch {
    return [];
  }
}

function writeIndex(docs: CurriculumDocument[]) {
  ensureDirs();
  fs.writeFileSync(INDEX_FILE, JSON.stringify(docs, null, 2));
}

export function upsertDocMeta(doc: CurriculumDocument) {
  const idx = readIndex().filter((d) => d.id !== doc.id);
  writeIndex([...idx, doc]);
}

export function getDocMeta(id: string): CurriculumDocument | null {
  return readIndex().find((d) => d.id === id) ?? null;
}

export function deleteDoc(id: string) {
  writeIndex(readIndex().filter((d) => d.id !== id));
  const chunksFile = path.join(DOCS_DIR, `${id}.json`);
  if (fs.existsSync(chunksFile)) fs.unlinkSync(chunksFile);
  invalidateChunkCache(id);
  logger.info({ docId: id }, 'Deleted curriculum document');
}

// ─── Chunk I/O ────────────────────────────────────────────────────────────────

export function saveChunks(docId: string, chunks: CurriculumChunk[]) {
  ensureDirs();
  fs.writeFileSync(path.join(DOCS_DIR, `${docId}.json`), JSON.stringify(chunks));
  // Always invalidate cache after a write so the next search reads fresh data
  invalidateChunkCache(docId);
}

export function loadChunks(docId: string): CurriculumChunk[] {
  // Return from cache if available
  const cached = _chunkCache.get(docId);
  if (cached) return cached;

  const f = path.join(DOCS_DIR, `${docId}.json`);
  if (!fs.existsSync(f)) return [];
  try {
    const chunks = JSON.parse(fs.readFileSync(f, 'utf8')) as CurriculumChunk[];
    _chunkCache.set(docId, chunks);
    return chunks;
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Arabic normalization
//
// This PDF has two known extraction artifacts:
//   1. U+FFFD (replacement char) inserted INSIDE Arabic words where pdfjs
//      could not decode a glyph — e.g. "أ?سبابها" instead of "أسبابها"
//   2. Tashkeel/diacritics separated by spaces from their base letters,
//      producing single-char tokens that break word boundaries
//
// Fix: strip ALL problematic characters so that "?أ?سبابها" → "اسبابها"
// and matching against query "اسباب" succeeds via substring.
// ─────────────────────────────────────────────────────────────────────────────

export function normalizeArabic(text: string): string {
  return (
    text
      // Step 1: Unicode compatibility normalization (merge composed chars)
      .normalize('NFKC')
      // Step 2: Remove BOM
      .replace(/\uFEFF/g, '')
      // Step 3: Remove zero-width and directional Unicode marks
      .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F]/g, '')
      // Step 4: *** Remove U+FFFD replacement chars (KEY FIX) ***
      // These appear inside Arabic words when pdfjs cannot decode a glyph
      .replace(/\uFFFD/g, '')
      // Step 5: Remove all Arabic tashkeel / diacritics
      .replace(/[\u064B-\u065F\u0670\u06D6-\u06DC\u06DF-\u06E4\u06E7\u06E8\u06EA-\u06ED]/g, '')
      // Step 6: Normalize Alef variants → bare Alef
      .replace(/[أإآٱ\u0671\u0672\u0673]/g, 'ا')
      // Step 7: Normalize Hamza on Waw and Ya
      .replace(/ؤ/g, 'و')
      .replace(/ئ/g, 'ي')
      // Step 8: Alef Maqsura → Ya (for morphological matching)
      .replace(/ى/g, 'ي')
      // Step 9: Teh Marbuta → Ha
      .replace(/ة/g, 'ه')
      // Step 10: Remove Arabic Tatweel (kashida)
      .replace(/\u0640/g, '')
      // Step 11: Replace any remaining non-Arabic/Latin/digit/space with space
      .replace(/[^\u0600-\u06FF\w\s]/g, ' ')
      // Step 12: Collapse whitespace
      .replace(/\s{2,}/g, ' ')
      .toLowerCase()
      .trim()
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tokenizer — splits normalized text into searchable tokens
// ─────────────────────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'في', 'من', 'إلى', 'على', 'أن', 'هذا', 'هذه', 'التي', 'الذي', 'كان',
  'بين', 'ما', 'هو', 'هي', 'لا', 'عن', 'مع', 'بعد', 'قبل', 'كل', 'عند',
  'كانت', 'يكون', 'وهو', 'وهي', 'ذلك', 'تلك', 'هناك', 'حيث', 'وقد', 'قد',
  'ان', 'هذا', 'هذه', 'الذي', 'التي', 'كان', 'كانت', 'ليس', 'لكن', 'اذا',
  'the', 'and', 'of', 'to', 'a', 'in', 'is', 'are', 'was', 'for', 'with',
  'as', 'by', 'at', 'an', 'or', 'it', 'be', 'has', 'had',
]);

export function tokenize(text: string): string[] {
  return normalizeArabic(text)
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

// ─────────────────────────────────────────────────────────────────────────────
// Character trigrams for semantic fallback
// ─────────────────────────────────────────────────────────────────────────────

function buildTrigrams(normalizedText: string): Set<string> {
  const s = normalizedText.replace(/\s+/g, '');
  const result = new Set<string>();
  for (let i = 0; i + 2 < s.length; i++) {
    result.add(s.slice(i, i + 3));
  }
  return result;
}

function trigramScore(queryTrigrams: Set<string>, chunkNormalized: string): number {
  if (queryTrigrams.size === 0) return 0;
  const target = buildTrigrams(chunkNormalized);
  let hits = 0;
  for (const t of queryTrigrams) {
    if (target.has(t)) hits++;
  }
  return hits / queryTrigrams.size;
}

// ─────────────────────────────────────────────────────────────────────────────
// Grade / level mapping
//
// Supports both directions:
//   level  → grades  e.g. 'secondary' → {grade10, grade11, grade12}
//   grade  → itself  e.g. 'grade12'   → {grade12}
//
// This means a doc uploaded with grade='grade12' is found when searching
// with gradeOrLevel='secondary', AND a doc uploaded with grade='secondary'
// is found when searching with gradeOrLevel='secondary'.
// ─────────────────────────────────────────────────────────────────────────────

export const LEVEL_GRADE_MAP: Record<string, string[]> = {
  primary: ['grade1', 'grade2', 'grade3', 'grade4', 'grade5', 'grade6'],
  preparatory: ['grade7', 'grade8', 'grade9'],
  secondary: ['grade10', 'grade11', 'grade12'],
};

function resolveGrades(gradeOrLevel: string): Set<string> {
  const mapped = LEVEL_GRADE_MAP[gradeOrLevel];
  if (mapped) {
    // It's a level name — include all grades for that level PLUS the level name itself
    // (handles docs uploaded with grade='secondary' directly)
    return new Set<string>([...mapped, gradeOrLevel]);
  }
  // It's a specific grade value — also check if it belongs to a level and include the level name
  const levelEntry = Object.entries(LEVEL_GRADE_MAP).find(([, grades]) =>
    grades.includes(gradeOrLevel)
  );
  if (levelEntry) {
    return new Set<string>([gradeOrLevel, levelEntry[0], ...levelEntry[1]]);
  }
  return new Set<string>([gradeOrLevel]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main search
// ─────────────────────────────────────────────────────────────────────────────

export function searchChunks(
  country: string,
  gradeOrLevel: string,
  subject: string,
  query: string,
  topK = 5
): CurriculumChunk[] {
  const validGrades = resolveGrades(gradeOrLevel);

  // Always read the index fresh from disk — no in-memory index cache
  const docs = readIndex().filter(
    (d) =>
      d.status === 'done' &&
      d.country === country &&
      d.subject === subject &&
      validGrades.has(d.grade)
  );

  if (docs.length === 0) {
    console.log(
      `[search] No docs — country=${country} grade/level=${gradeOrLevel}` +
      ` (validGrades=[${[...validGrades].join(',')}]) subject=${subject}`
    );
    return [];
  }

  const allChunks = docs.flatMap((d) => loadChunks(d.id));
  console.log(`[search] ${allChunks.length} chunks from ${docs.length} doc(s). Query="${query}"`);
  if (allChunks.length === 0) return [];
  if (!query.trim()) return allChunks.slice(0, topK);

  // Normalize query
  const qNorm = normalizeArabic(query);
  const qTokens = tokenize(query);
  const qTrigrams = buildTrigrams(qNorm);

  console.log(`[search] Normalized query="${qNorm}" tokens=[${qTokens.join(', ')}]`);

  // Score every chunk
  const scored = allChunks.map((chunk) => {
    // Use pre-computed normalized content if available, else compute on-the-fly
    const cNorm = chunk.contentNormalized ?? normalizeArabic(chunk.content);
    const cTokenSet = new Set(tokenize(chunk.content));
    const chapterNorm = normalizeArabic(chunk.chapter);

    let score = 0;

    for (const qt of qTokens) {
      // A: exact token match
      if (cTokenSet.has(qt)) score += 4;

      // B: direct substring in full normalized content (handles partial/compound words
      //    AND words where U+FFFD stripped the alef prefix, e.g. "لطفرات" ⊃ "طفرات")
      if (cNorm.includes(qt)) score += 5;

      // C: query token is substring of any content token (morphological suffix)
      for (const ct of cTokenSet) {
        if (ct.includes(qt)) { score += 2; break; }
      }

      // D: keyword match (normalized stored keywords)
      if (chunk.keywords.some((k) => normalizeArabic(k).includes(qt))) score += 3;

      // E: chapter name match
      if (chapterNorm.includes(qt)) score += 10;
    }

    // F: full normalized query as substring (phrase match — highest signal)
    if (cNorm.includes(qNorm)) score += 20;
    if (chapterNorm.includes(qNorm)) score += 30;

    // G: trigram similarity (always computed — gives partial credit for corrupted text)
    const tSim = trigramScore(qTrigrams, cNorm);
    score += tSim * 15;

    return { chunk, score, tSim };
  });

  // Sort and take topK — no minimum score threshold (let all chunks compete)
  const result = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .filter((r) => r.score > 0.5) // only require minimal signal
    .map((r) => r.chunk);

  console.log(
    `[search] Top results:`,
    scored
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.min(5, topK))
      .map((r) => `chunk#${r.chunk.chunkIndex} pages=${r.chunk.pageRange} score=${r.score.toFixed(2)} tSim=${r.tSim.toFixed(3)}`)
  );

  return result;
}
