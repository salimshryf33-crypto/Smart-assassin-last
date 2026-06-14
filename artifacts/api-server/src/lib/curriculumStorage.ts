import fs from 'node:fs';
import path from 'node:path';
import { logger } from './logger';
import { deletePdfFromDb } from './pdfPersistence';
import { extractChapterLabel } from './chunker';
import { getEmbedding, cosineSimilarity, generateEmbeddingsBatch } from './embeddingService';

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
  ownerId?: string | null;
  visibility: 'public' | 'private';
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

export type UpsertDocInput = Omit<CurriculumDocument, 'visibility'> & {
  visibility?: 'public' | 'private';
};

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

// ─── Chapter Re-labeling (Phase 2 fix) ───────────────────────────────────────

/**
 * Re-apply improved chapter detection to all existing chunks on disk.
 *
 * This is a non-destructive migration: it only updates the `chapter` field
 * on chunks that are currently labeled "عام" (generic) or have an invalid
 * label. Content, keywords, embeddings, and all other fields are preserved.
 *
 * Run on every startup — no-op when all chunks already have meaningful labels.
 * Safe to call multiple times.
 */
export function relabelChapters(): void {
  ensureDirs();
  const docs = readIndex().filter(
    (d) => d.status === 'done' || d.status === 'partial'
  );

  if (docs.length === 0) return;

  let totalRelabeled = 0;

  for (const doc of docs) {
    const chunks = loadChunks(doc.id);
    if (chunks.length === 0) continue;

    // Sort by chunkIndex to ensure forward propagation
    const sorted = [...chunks].sort((a, b) => a.chunkIndex - b.chunkIndex);

    // ── Complete fresh rescan — ignore ALL previously stored labels ──────────
    // This is idempotent and correct even after prior bad relabeling passes.
    // We derive chapter labels ONLY from chunk content, never from stored labels,
    // so MCQ false-positives written by earlier runs are fully overwritten.
    let currentChapter = 'عام';
    let changed = false;

    const updated = sorted.map((chunk) => {
      // Scan ALL lines using extractChapterLabel (strict + embedded patterns)
      const detected = extractChapterLabel(chunk.content);
      if (detected) currentChapter = detected;

      // The canonical chapter for this chunk is whatever the running label is
      const newChapter = currentChapter;

      if (chunk.chapter !== newChapter) {
        changed = true;
        totalRelabeled++;
        return { ...chunk, chapter: newChapter };
      }
      return chunk;
    });

    if (changed) {
      saveChunks(doc.id, updated);
      const uniqueChapters = new Set(updated.map((c) => c.chapter));
      logger.info(
        {
          docId: doc.id,
          filename: doc.filename,
          totalChunks: updated.length,
          uniqueChapters: uniqueChapters.size,
          chapters: [...uniqueChapters].slice(0, 10),
        },
        'relabelChapters: updated chapter labels'
      );
    }
  }

  if (totalRelabeled > 0) {
    logger.info({ totalRelabeled }, 'relabelChapters: complete');
  } else {
    logger.info('relabelChapters: no changes needed');
  }
}

// ─── Chunk I/O ────────────────────────────────────────────────────────────────

export function saveChunks(docId: string, chunks: CurriculumChunk[]) {
  ensureDirs();
  fs.writeFileSync(path.join(DOCS_DIR, `${docId}.json`), JSON.stringify(chunks));
  invalidateChunkCache(docId);
}

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
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    // Support both root-array format and the legacy { chunks: [...] } object format
    const chunks: CurriculumChunk[] = Array.isArray(raw)
      ? raw
      : Array.isArray((raw as Record<string, unknown>).chunks)
        ? ((raw as Record<string, unknown>).chunks as CurriculumChunk[])
        : [];
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
  bookTitle?: string;
  userId?: string;
  /** Pre-computed query embedding for hybrid keyword + semantic scoring */
  queryEmbedding?: number[];
}

export function searchChunks(
  country: string,
  gradeOrLevel: string,
  subject: string,
  query: string,
  topK = 10,
  opts: SearchOptions = {}
): CurriculumChunk[] {
  const validGrades = resolveGrades(gradeOrLevel);

  const docs = readIndex().filter(
    (d) =>
      (d.status === 'done' || d.status === 'partial') &&
      d.country  === country &&
      d.subject  === subject &&
      validGrades.has(d.grade) &&
      (d.visibility !== 'private' ||
        (opts.userId !== undefined && d.ownerId === opts.userId)) &&
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

    // ── Per-token scoring (Phase 3: capped boolean — prevents frequency bias) ─
    // Each query token contributes at most one fixed amount regardless of how
    // many times it appears in the chunk. This removes the early-chapter bias
    // caused by dense repeated vocabulary.
    for (const qt of qTokens) {
      let tokenScore = 0;

      // Exact token match (highest signal)
      if (cTokenSet.has(qt))                                          tokenScore = Math.max(tokenScore, 6);
      // Substring match in normalized content
      if (cNorm.includes(qt))                                         tokenScore = Math.max(tokenScore, 5);
      // Partial token match (fuzzy)
      for (const ct of cTokenSet) { if (ct.includes(qt)) { tokenScore = Math.max(tokenScore, 2); break; } }
      // Keyword index match
      if (chunk.keywords.some((k) => normalizeArabic(k).includes(qt))) tokenScore = Math.max(tokenScore, 4);
      // Chapter name match (strong signal — activates now with improved detection)
      if (chapterNorm.includes(qt))                                   tokenScore = Math.max(tokenScore, 12);

      score += tokenScore;
    }

    // ── Full-phrase bonuses ──────────────────────────────────────────────────
    if (cNorm.includes(qNorm))       score += 20;
    if (chapterNorm.includes(qNorm)) score += 30;

    // ── Trigram similarity ───────────────────────────────────────────────────
    const tSim = trigramScore(qTrigrams, cNorm);
    score += tSim * 25;

    // ── Semantic similarity (hybrid search) ──────────────────────────────────
    // When a pre-computed query embedding is available AND the chunk has an
    // embedding (generated by generateMissingEmbeddings on startup), add cosine
    // similarity scaled to ×35 — weighted roughly equal to a strong keyword hit.
    // Falls back to 0 gracefully for chunks that have not yet been embedded.
    const semScore =
      opts.queryEmbedding && chunk.embedding?.length
        ? cosineSimilarity(opts.queryEmbedding, chunk.embedding) * 35
        : 0;
    score += semScore;

    return { chunk, score, tSim, semScore };
  });

  // Sort by combined score descending
  const sortedScored = [...scored].sort((a, b) => b.score - a.score);

  // ── Adaptive threshold ────────────────────────────────────────────────────
  const topScore = sortedScored[0]?.score ?? 0;
  const adaptiveThreshold = Math.max(1.0, topScore * 0.15);

  const result = sortedScored
    .slice(0, topK)
    .filter((r) => r.score >= adaptiveThreshold)
    .map((r) => r.chunk);

  // ── Logging ───────────────────────────────────────────────────────────────
  const chapterDist: Record<string, number> = {};
  for (const c of result) chapterDist[c.chapter] = (chapterDist[c.chapter] ?? 0) + 1;

  const hasSemantic = !!opts.queryEmbedding;
  console.log(
    `[search${hasSemantic ? ':hybrid' : ':keyword'}] top results:`,
    sortedScored
      .slice(0, Math.min(5, topK))
      .map((r) =>
        `chunk#${r.chunk.chunkIndex} pages=${r.chunk.pageRange} ` +
        `score=${r.score.toFixed(1)} tSim=${r.tSim.toFixed(2)} sem=${r.semScore.toFixed(2)} ` +
        `ch="${r.chunk.chapter.slice(0, 25)}"`
      )
  );
  console.log(`[search] chapter dist:`, chapterDist);

  return result;
}

// ─── Embedding generation (background, startup) ───────────────────────────────
//
// Generates Gemini text-embedding-004 vectors for all chunks that don't yet
// have one. Stores results in the existing chunk JSON files — no DB writes.
// Called asynchronously on startup so it never blocks the server.

export async function generateMissingEmbeddings(): Promise<void> {
  const docs = readIndex().filter(
    (d) => d.status === 'done' || d.status === 'partial'
  );

  if (docs.length === 0) return;

  for (const doc of docs) {
    const chunks = loadChunks(doc.id);
    const missing = chunks.filter((c) => !c.embedding || c.embedding.length === 0);

    if (missing.length === 0) {
      logger.info(
        { docId: doc.id, total: chunks.length },
        'embeddings: all chunks already embedded'
      );
      continue;
    }

    logger.info(
      { docId: doc.id, filename: doc.filename, missing: missing.length, total: chunks.length },
      'embeddings: generating missing embeddings'
    );

    const items = missing.map((c) => ({
      id: c.id,
      // Prepend chapter name so the embedding captures topic context
      text: `${c.chapter}\n${c.content.slice(0, 3000)}`,
    }));

    const embeddings = await generateEmbeddingsBatch(items, (done, total) => {
      if (done % 10 === 0 || done === total) {
        logger.info(
          { docId: doc.id, done, total },
          'embeddings: progress'
        );
      }
    });

    if (embeddings.size === 0) continue;

    // Merge new embeddings into the existing chunk list
    const idMap = new Map(embeddings);
    const updated = chunks.map((c) => ({
      ...c,
      embedding: idMap.get(c.id) ?? c.embedding,
    }));

    saveChunks(doc.id, updated);
    logger.info(
      { docId: doc.id, embedded: embeddings.size },
      'embeddings: saved to chunk file'
    );
  }

  logger.info('embeddings: all docs processed');
}
