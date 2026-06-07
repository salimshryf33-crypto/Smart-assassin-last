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
  contentNormalized: string;
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
  status: 'queued' | 'processing' | 'ocr_running' | 'partial' | 'done' | 'error';
  errorMessage?: string;
  uploadedAt: number;
  processedAt?: number;
  docType?: 'book' | 'note' | 'exam';
  // ─── Extraction quality metadata ─────────────────────────────────────────
  extractionMethod?: 'text' | 'virtual' | 'ocr';
  extractedChars?: number;
  avgCharsPerPage?: number;
  extractedPages?: number;
  // ─── OCR resume metadata ──────────────────────────────────────────────────
  // lastRenderedPage: the last PDF page number (1-based) confirmed OCR'd and
  // saved to disk. Set after every successful batch so a quota failure mid-book
  // always leaves a valid resume point.
  lastRenderedPage?: number;
  // pdfStoragePath: permanent path to the original uploaded PDF.
  // Set at upload time, never deleted automatically, enables re-index without
  // requiring the user to re-upload the file.
  pdfStoragePath?: string;
}

const DATA_DIR = path.join(process.cwd(), 'data', 'curriculum');
const DOCS_DIR = path.join(DATA_DIR, 'docs');
const INDEX_FILE = path.join(DATA_DIR, 'index.json');

// Permanent PDF storage — never auto-deleted
export const PDF_DIR = path.join(process.cwd(), 'data', 'pdfs');

export function getPdfPath(docId: string): string {
  return path.join(PDF_DIR, `${docId}.pdf`);
}

function ensureDirs() {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  fs.mkdirSync(PDF_DIR, { recursive: true });
}

// ─── In-memory chunk cache ────────────────────────────────────────────────────
const _chunkCache = new Map<string, CurriculumChunk[]>();

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
  // Also delete the permanently stored PDF
  const pdfFile = getPdfPath(id);
  if (fs.existsSync(pdfFile)) {
    try { fs.unlinkSync(pdfFile); } catch { /* ignore */ }
  }
  invalidateChunkCache(id);
  logger.info({ docId: id }, 'Deleted curriculum document and stored PDF');
}

// ─── Chunk I/O ────────────────────────────────────────────────────────────────

export function saveChunks(docId: string, chunks: CurriculumChunk[]) {
  ensureDirs();
  fs.writeFileSync(path.join(DOCS_DIR, `${docId}.json`), JSON.stringify(chunks));
  invalidateChunkCache(docId);
}

/**
 * Append new chunks to an existing doc's chunk file.
 *
 * Used during OCR resume: new chunks from pages 93–215 are merged with the
 * existing 46 chunks from pages 1–92. New chunks are renumbered so their
 * chunkIndex continues from the highest existing index.
 *
 * If no existing chunks are found (first save), behaves identically to saveChunks.
 */
export function appendChunks(docId: string, newChunks: CurriculumChunk[]) {
  if (newChunks.length === 0) return;

  const existing = loadChunks(docId);
  const nextIndex = existing.length > 0
    ? Math.max(...existing.map((c) => c.chunkIndex)) + 1
    : 0;

  const renumbered = newChunks.map((c, i) => ({ ...c, chunkIndex: nextIndex + i }));
  const merged = [...existing, ...renumbered];

  saveChunks(docId, merged);
  logger.info(
    { docId, existingCount: existing.length, newCount: newChunks.length, totalCount: merged.length },
    'Appended chunks to existing doc'
  );
}

export function loadChunks(docId: string): CurriculumChunk[] {
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
// ─────────────────────────────────────────────────────────────────────────────

export function normalizeArabic(text: string): string {
  return (
    text
      .normalize('NFKC')
      .replace(/\uFEFF/g, '')
      .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F]/g, '')
      .replace(/\uFFFD/g, '')
      .replace(/[\u064B-\u065F\u0670\u06D6-\u06DC\u06DF-\u06E4\u06E7\u06E8\u06EA-\u06ED]/g, '')
      .replace(/[أإآٱ\u0671\u0672\u0673]/g, 'ا')
      .replace(/ؤ/g, 'و')
      .replace(/ئ/g, 'ي')
      .replace(/ى/g, 'ي')
      .replace(/ة/g, 'ه')
      .replace(/\u0640/g, '')
      .replace(/[^\u0600-\u06FF\w\s]/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .toLowerCase()
      .trim()
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tokenizer
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
// Character trigrams
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
// ─────────────────────────────────────────────────────────────────────────────

export const LEVEL_GRADE_MAP: Record<string, string[]> = {
  primary: ['grade1', 'grade2', 'grade3', 'grade4', 'grade5', 'grade6'],
  preparatory: ['grade7', 'grade8', 'grade9'],
  secondary: ['grade10', 'grade11', 'grade12'],
};

function resolveGrades(gradeOrLevel: string): Set<string> {
  const mapped = LEVEL_GRADE_MAP[gradeOrLevel];
  if (mapped) {
    return new Set<string>([...mapped, gradeOrLevel]);
  }
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

  const docs = readIndex().filter(
    (d) =>
      // Include both completed and partial docs — partial docs have valid chunks
      // for the pages already processed and are fully searchable
      (d.status === 'done' || d.status === 'partial') &&
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

  const qNorm = normalizeArabic(query);
  const qTokens = tokenize(query);
  const qTrigrams = buildTrigrams(qNorm);

  console.log(`[search] Normalized query="${qNorm}" tokens=[${qTokens.join(', ')}]`);

  const scored = allChunks.map((chunk) => {
    const cNorm = chunk.contentNormalized ?? normalizeArabic(chunk.content);
    const cTokenSet = new Set(tokenize(chunk.content));
    const chapterNorm = normalizeArabic(chunk.chapter);

    let score = 0;

    for (const qt of qTokens) {
      if (cTokenSet.has(qt)) score += 4;
      if (cNorm.includes(qt)) score += 5;
      for (const ct of cTokenSet) {
        if (ct.includes(qt)) { score += 2; break; }
      }
      if (chunk.keywords.some((k) => normalizeArabic(k).includes(qt))) score += 3;
      if (chapterNorm.includes(qt)) score += 10;
    }

    if (cNorm.includes(qNorm)) score += 20;
    if (chapterNorm.includes(qNorm)) score += 30;

    const tSim = trigramScore(qTrigrams, cNorm);
    score += tSim * 15;

    return { chunk, score, tSim };
  });

  const result = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .filter((r) => {
      if (r.score <= 4.0) return false;
      const directScore = r.score - r.tSim * 15;
      if (directScore < 0.5 && r.tSim < 0.35) return false;
      return true;
    })
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
