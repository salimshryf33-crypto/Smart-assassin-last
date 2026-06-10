import fs from 'node:fs';
import path from 'node:path';
import { logger } from './logger';
import { deletePdfFromDb } from './pdfPersistence';

// ─── Chunk ────────────────────────────────────────────────────────────────────

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

// ─── Document ─────────────────────────────────────────────────────────────────

export interface CurriculumDocument {
  id: string;
  country: string;
  grade: string;
  subject: string;
  track: string;
  filename: string;
  totalPages: number;
  chunkCount: number;
  status: 'queued' | 'processing' | 'ocr_running' | 'partial' | 'resuming' | 'done' | 'error';
  errorMessage?: string;
  uploadedAt: number;
  processedAt?: number;
  docType?: 'book' | 'note' | 'exam';

  // ─── Ownership & visibility ───────────────────────────────────────────────
  /**
   * Firebase UID of the uploader.
   * null / undefined = system-managed public content (admin-uploaded books).
   */
  ownerId?: string | null;
  /**
   * 'public'  → visible to all authenticated users (curriculum books).
   * 'private' → visible only to the owner (personal notes / exams).
   * Defaults to 'public' for all legacy docs and books without explicit value.
   */
  visibility: 'public' | 'private';
  /**
   * Human-readable book title — distinguishes multiple books under the same
   * subject, e.g. "النحو والصرف" vs "الأدب والنصوص" vs "فيزياء 3".
   * Defaults to filename stem when not provided at upload time.
   */
  bookTitle?: string;

  // ─── Extraction quality ───────────────────────────────────────────────────
  extractionMethod?: 'text' | 'virtual' | 'ocr';
  extractedChars?: number;
  avgCharsPerPage?: number;
  extractedPages?: number;

  // ─── OCR resume ───────────────────────────────────────────────────────────
  lastRenderedPage?: number;
  pdfStoragePath?: string;

  // ─── Auto-resume scheduler ────────────────────────────────────────────────
  lastResumeAttempt?: number;
  resumeAttempts?: number;
  lastResumeError?: string;
}

// ─── Paths ────────────────────────────────────────────────────────────────────

const DATA_DIR  = path.join(process.cwd(), 'data', 'curriculum');
const DOCS_DIR  = path.join(DATA_DIR, 'docs');
const INDEX_FILE = path.join(DATA_DIR, 'index.json');

export const PDF_DIR = path.join(process.cwd(), 'data', 'pdfs');

export function getPdfPath(docId: string): string {
  return path.join(PDF_DIR, `${docId}.pdf`);
}

function ensureDirs() {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  fs.mkdirSync(PDF_DIR,  { recursive: true });
}

// ─── Chunk cache ──────────────────────────────────────────────────────────────

const _chunkCache = new Map<string, CurriculumChunk[]>();

export function invalidateChunkCache(docId?: string) {
  if (docId) _chunkCache.delete(docId);
  else       _chunkCache.clear();
}

// ─── Index I/O ────────────────────────────────────────────────────────────────

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

/**
 * Input type for upsertDocMeta — same as CurriculumDocument but with
 * `visibility` optional (defaults to existing value or 'public').
 * This lets callers that only update status/progress omit visibility safely.
 */
export type UpsertDocInput = Omit<CurriculumDocument, 'visibility'> & {
  visibility?: 'public' | 'private';
};

/**
 * Upsert a document in the index.
 *
 * Ownership fields (ownerId, visibility, bookTitle) are **preserved from the
 * existing record** when not explicitly provided, so callers that only update
 * status / OCR progress don't need to carry these fields through every code
 * path — they will never accidentally be cleared.
 */
export function upsertDocMeta(doc: UpsertDocInput): void {
  const all      = readIndex();
  const existing = all.find((d) => d.id === doc.id);

  const merged: CurriculumDocument = {
    ...doc,
    ownerId:    doc.ownerId    !== undefined ? doc.ownerId    : existing?.ownerId,
    visibility: doc.visibility ?? existing?.visibility ?? 'public',
    bookTitle:  doc.bookTitle  ?? existing?.bookTitle,
  };

  writeIndex([...all.filter((d) => d.id !== merged.id), merged]);
}

export function getDocMeta(id: string): CurriculumDocument | null {
  return readIndex().find((d) => d.id === id) ?? null;
}

export function deleteDoc(id: string) {
  writeIndex(readIndex().filter((d) => d.id !== id));

  const chunksFile = path.join(DOCS_DIR, `${id}.json`);
  if (fs.existsSync(chunksFile)) fs.unlinkSync(chunksFile);

  const pdfFile = getPdfPath(id);
  if (fs.existsSync(pdfFile)) {
    try { fs.unlinkSync(pdfFile); } catch { /* ignore */ }
  }

  deletePdfFromDb(id).catch((err) =>
    logger.error({ err, docId: id }, 'deleteDoc: failed to remove PDF from DB')
  );

  invalidateChunkCache(id);
  logger.info({ docId: id }, 'Deleted curriculum doc, disk PDF, and DB PDF');
}

// ─── Startup migration ────────────────────────────────────────────────────────

/**
 * One-time safe migration: adds `visibility` and `bookTitle` defaults to
 * legacy documents that pre-date the ownership system.
 *
 * Rules:
 *   visibility → 'public'  for books (or unknown type)
 *              → 'private' for notes / exams
 *   bookTitle  → filename stem (strips .pdf extension)
 *   ownerId    → left undefined (legacy public content has no owner)
 *
 * Safe to call on every startup — no-op when all docs already have the fields.
 */
export function migrateIndex(): void {
  const docs = readIndex();
  if (docs.length === 0) return;

  let changed = false;

  const migrated = docs.map((d): CurriculumDocument => {
    let updated = false;
    const next = { ...d } as CurriculumDocument;

    if (!next.visibility) {
      next.visibility =
        next.docType === 'note' || next.docType === 'exam' ? 'private' : 'public';
      updated = true;
    }

    if (next.bookTitle === undefined || next.bookTitle === '') {
      next.bookTitle =
        next.filename.replace(/\.pdf$/i, '').trim() || next.filename;
      updated = true;
    }

    if (updated) changed = true;
    return next;
  });

  if (changed) {
    writeIndex(migrated);
    logger.info(
      { count: migrated.length },
      'migrateIndex: added visibility/bookTitle defaults to legacy docs'
    );
  }
}

// ─── Chunk I/O ────────────────────────────────────────────────────────────────

export function saveChunks(docId: string, chunks: CurriculumChunk[]) {
  ensureDirs();
  fs.writeFileSync(path.join(DOCS_DIR, `${docId}.json`), JSON.stringify(chunks));
  invalidateChunkCache(docId);
}

/**
 * Append new chunks to an existing doc (OCR resume path).
 * Renumbers new chunks to continue from the highest existing index.
 */
export function appendChunks(docId: string, newChunks: CurriculumChunk[]) {
  if (newChunks.length === 0) return;

  const existing  = loadChunks(docId);
  const nextIndex = existing.length > 0
    ? Math.max(...existing.map((c) => c.chunkIndex)) + 1
    : 0;

  const renumbered = newChunks.map((c, i) => ({ ...c, chunkIndex: nextIndex + i }));
  const merged     = [...existing, ...renumbered];

  saveChunks(docId, merged);
  logger.info(
    { docId, existingCount: existing.length, newCount: newChunks.length, totalCount: merged.length },
    'appendChunks: merged new chunks'
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

// ─── Arabic normalisation ─────────────────────────────────────────────────────

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

// ─── Tokeniser ────────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'في', 'من', 'إلى', 'على', 'أن', 'هذا', 'هذه', 'التي', 'الذي', 'كان',
  'بين', 'ما', 'هو', 'هي', 'لا', 'عن', 'مع', 'بعد', 'قبل', 'كل', 'عند',
  'كانت', 'يكون', 'وهو', 'وهي', 'ذلك', 'تلك', 'هناك', 'حيث', 'وقد', 'قد',
  'ان', 'الذي', 'التي', 'ليس', 'لكن', 'اذا',
  'the', 'and', 'of', 'to', 'a', 'in', 'is', 'are', 'was', 'for', 'with',
  'as', 'by', 'at', 'an', 'or', 'it', 'be', 'has', 'had',
]);

export function tokenize(text: string): string[] {
  return normalizeArabic(text)
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

// ─── Trigrams ─────────────────────────────────────────────────────────────────

function buildTrigrams(normalizedText: string): Set<string> {
  const s = normalizedText.replace(/\s+/g, '');
  const result = new Set<string>();
  for (let i = 0; i + 2 < s.length; i++) result.add(s.slice(i, i + 3));
  return result;
}

function trigramScore(queryTrigrams: Set<string>, chunkNormalized: string): number {
  if (queryTrigrams.size === 0) return 0;
  const target = buildTrigrams(chunkNormalized);
  let hits = 0;
  for (const t of queryTrigrams) if (target.has(t)) hits++;
  return hits / queryTrigrams.size;
}

// ─── Grade / level mapping ────────────────────────────────────────────────────

export const LEVEL_GRADE_MAP: Record<string, string[]> = {
  primary:     ['grade1', 'grade2', 'grade3', 'grade4', 'grade5', 'grade6'],
  preparatory: ['grade7', 'grade8', 'grade9'],
  secondary:   ['grade10', 'grade11', 'grade12'],
};

function resolveGrades(gradeOrLevel: string): Set<string> {
  const mapped = LEVEL_GRADE_MAP[gradeOrLevel];
  if (mapped) return new Set<string>([...mapped, gradeOrLevel]);

  const entry = Object.entries(LEVEL_GRADE_MAP).find(([, grades]) =>
    grades.includes(gradeOrLevel)
  );
  if (entry) return new Set<string>([gradeOrLevel, entry[0], ...entry[1]]);
  return new Set<string>([gradeOrLevel]);
}

// ─── Search ───────────────────────────────────────────────────────────────────

export interface SearchOptions {
  /**
   * Mode B — restrict to a specific book title.
   * Omit for Mode A (search all books in the subject).
   */
  bookTitle?: string;
  /**
   * Firebase UID of the requesting user.
   * Required to include private (note/exam) docs in results.
   * Omit for public-only search (AI chat default).
   */
  userId?: string;
}

export function searchChunks(
  country: string,
  gradeOrLevel: string,
  subject: string,
  query: string,
  topK = 5,
  opts: SearchOptions = {}
): CurriculumChunk[] {
  const validGrades = resolveGrades(gradeOrLevel);

  const docs = readIndex().filter(
    (d) =>
      (d.status === 'done' || d.status === 'partial') &&
      d.country  === country &&
      d.subject  === subject &&
      validGrades.has(d.grade) &&
      // Visibility gate: public docs always visible;
      // private docs only visible to their owner.
      (d.visibility !== 'private' ||
        (opts.userId !== undefined && d.ownerId === opts.userId)) &&
      // Mode B: book-specific filter
      (!opts.bookTitle || d.bookTitle === opts.bookTitle)
  );

  if (docs.length === 0) {
    console.log(
      `[search] No docs — country=${country} grade=${gradeOrLevel}` +
      ` subject=${subject} bookTitle=${opts.bookTitle ?? '*'} userId=${opts.userId ?? 'anon'}`
    );
    return [];
  }

  const allChunks = docs.flatMap((d) => loadChunks(d.id));
  console.log(
    `[search] ${allChunks.length} chunks from ${docs.length} doc(s). ` +
    `query="${query}" bookTitle=${opts.bookTitle ?? '*'}`
  );

  if (allChunks.length === 0) return [];
  if (!query.trim())         return allChunks.slice(0, topK);

  const qNorm     = normalizeArabic(query);
  const qTokens   = tokenize(query);
  const qTrigrams = buildTrigrams(qNorm);

  const scored = allChunks.map((chunk) => {
    const cNorm      = chunk.contentNormalized ?? normalizeArabic(chunk.content);
    const cTokenSet  = new Set(tokenize(chunk.content));
    const chapterNorm = normalizeArabic(chunk.chapter);

    let score = 0;
    for (const qt of qTokens) {
      if (cTokenSet.has(qt))                                            score += 4;
      if (cNorm.includes(qt))                                           score += 5;
      for (const ct of cTokenSet) { if (ct.includes(qt)) { score += 2; break; } }
      if (chunk.keywords.some((k) => normalizeArabic(k).includes(qt))) score += 3;
      if (chapterNorm.includes(qt))                                     score += 10;
    }
    if (cNorm.includes(qNorm))      score += 20;
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
    `[search] top results:`,
    scored
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.min(5, topK))
      .map((r) =>
        `chunk#${r.chunk.chunkIndex} pages=${r.chunk.pageRange} ` +
        `score=${r.score.toFixed(2)} tSim=${r.tSim.toFixed(3)}`
      )
  );

  return result;
}
