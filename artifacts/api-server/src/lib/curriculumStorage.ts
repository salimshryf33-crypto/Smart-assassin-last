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
  logger.info({ docId: id }, 'Deleted curriculum document');
}

export function saveChunks(docId: string, chunks: CurriculumChunk[]) {
  ensureDirs();
  fs.writeFileSync(path.join(DOCS_DIR, `${docId}.json`), JSON.stringify(chunks));
}

export function loadChunks(docId: string): CurriculumChunk[] {
  const f = path.join(DOCS_DIR, `${docId}.json`);
  if (!fs.existsSync(f)) return [];
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8')) as CurriculumChunk[];
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────
// Arabic text normalization
// ─────────────────────────────────────────────

export function normalizeArabic(text: string): string {
  return (
    text
      // Remove all diacritics / tashkeel
      .replace(/[\u064B-\u065F\u0670\u06D6-\u06DC\u06DF-\u06E4\u06E7\u06E8\u06EA-\u06ED]/g, '')
      // Normalize alef + hamza variants → bare alef
      .replace(/[أإآٱ]/g, 'ا')
      // Normalize hamza on waw/ya
      .replace(/ؤ/g, 'و')
      .replace(/ئ/g, 'ي')
      // Normalize teh marbuta → ha (helps with morphological variants)
      .replace(/ة/g, 'ه')
      .toLowerCase()
      .trim()
  );
}

const STOP_WORDS = new Set([
  'في', 'من', 'إلى', 'على', 'أن', 'هذا', 'هذه', 'التي', 'الذي', 'كان',
  'بين', 'ما', 'هو', 'هي', 'لا', 'عن', 'مع', 'بعد', 'قبل', 'كل', 'عند',
  'كانت', 'يكون', 'وهو', 'وهي', 'ذلك', 'تلك', 'هناك', 'حيث', 'وقد', 'قد',
  'the', 'and', 'of', 'to', 'a', 'in', 'is', 'are', 'was', 'for', 'with',
  'as', 'by', 'at', 'an', 'or', 'it', 'be',
]);

function tokenize(raw: string): string[] {
  return normalizeArabic(raw)
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

// Character trigram set for semantic similarity fallback
function buildTrigrams(text: string): Set<string> {
  const result = new Set<string>();
  const t = normalizeArabic(text).replace(/\s+/g, '');
  for (let i = 0; i + 2 < t.length; i++) {
    result.add(t.slice(i, i + 3));
  }
  return result;
}

function trigramSimilarity(queryTrigrams: Set<string>, targetText: string): number {
  if (queryTrigrams.size === 0) return 0;
  const targetTrigrams = buildTrigrams(targetText);
  let hits = 0;
  for (const tri of queryTrigrams) {
    if (targetTrigrams.has(tri)) hits++;
  }
  return hits / queryTrigrams.size;
}

// ─────────────────────────────────────────────
// Grade / level mapping
// ─────────────────────────────────────────────

const LEVEL_GRADE_MAP: Record<string, string[]> = {
  primary: ['grade1', 'grade2', 'grade3', 'grade4', 'grade5', 'grade6'],
  preparatory: ['grade7', 'grade8', 'grade9'],
  secondary: ['grade10', 'grade11', 'grade12'],
};

// ─────────────────────────────────────────────
// Main search function
// ─────────────────────────────────────────────

export function searchChunks(
  country: string,
  gradeOrLevel: string,
  subject: string,
  query: string,
  topK = 5
): CurriculumChunk[] {
  // Support both exact grade ('grade12') and level ('secondary')
  const validGrades = new Set<string>(
    LEVEL_GRADE_MAP[gradeOrLevel] ?? [gradeOrLevel]
  );

  const docs = readIndex().filter(
    (d) =>
      d.status === 'done' &&
      d.country === country &&
      d.subject === subject &&
      validGrades.has(d.grade)
  );

  if (docs.length === 0) {
    console.log(`[curriculum-search] No docs found for country=${country} grade/level=${gradeOrLevel} subject=${subject}`);
    return [];
  }

  const allChunks = docs.flatMap((d) => loadChunks(d.id));
  console.log(`[curriculum-search] Loaded ${allChunks.length} chunks from ${docs.length} doc(s) for query="${query}"`);

  if (allChunks.length === 0) return [];

  if (!query.trim()) return allChunks.slice(0, topK);

  const normalizedQuery = normalizeArabic(query);
  const queryTokens = tokenize(query);
  const queryTrigrams = buildTrigrams(query);

  // ── Scoring ─────────────────────────────────
  const scored = allChunks.map((chunk) => {
    const normalizedContent = normalizeArabic(chunk.content);
    const contentTokens = new Set(tokenize(chunk.content));
    const normalizedChapter = normalizeArabic(chunk.chapter);

    let score = 0;

    for (const qt of queryTokens) {
      // 1. Exact normalized token match in content
      if (contentTokens.has(qt)) score += 3;

      // 2. Substring match — query token appears inside content token or vice versa
      for (const ct of contentTokens) {
        if (ct.includes(qt) || qt.includes(ct)) { score += 1; break; }
      }

      // 3. Direct substring in raw normalized content (catches compound words)
      if (normalizedContent.includes(qt)) score += 2;

      // 4. Match in stored (normalized) keywords
      if (chunk.keywords.some((k) => normalizeArabic(k) === qt || normalizeArabic(k).includes(qt))) {
        score += 4;
      }

      // 5. Chapter name match (strong signal)
      if (normalizedChapter.includes(qt)) score += 8;
    }

    // 6. Full query phrase as substring (strongest direct match)
    if (normalizedContent.includes(normalizedQuery)) score += 15;
    if (normalizedChapter.includes(normalizedQuery)) score += 20;

    return { chunk, score };
  });

  // ── Pass 1: keyword/phrase matches ──────────
  const keywordMatches = scored
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  if (keywordMatches.length >= Math.min(3, topK)) {
    const result = keywordMatches.map((r) => r.chunk);
    console.log(
      `[curriculum-search] keyword pass — found ${result.length} chunks:`,
      result.map((c) => `chunk#${c.chunkIndex} pages ${c.pageRange} score=${scored.find(s=>s.chunk.id===c.id)?.score}`)
    );
    return result;
  }

  // ── Pass 2: semantic trigram fallback ────────
  console.log(`[curriculum-search] keyword pass found only ${keywordMatches.length} — falling back to trigram similarity`);

  const semanticScored = allChunks.map((chunk) => ({
    chunk,
    sim: trigramSimilarity(queryTrigrams, chunk.content),
  }));

  const semanticResult = semanticScored
    .sort((a, b) => b.sim - a.sim)
    .slice(0, topK)
    .filter((r) => r.sim > 0.05)
    .map((r) => r.chunk);

  // Merge keyword partial matches + semantic results (deduplicated)
  const merged = [
    ...keywordMatches.map((r) => r.chunk),
    ...semanticResult.filter((c) => !keywordMatches.some((k) => k.chunk.id === c.id)),
  ].slice(0, topK);

  console.log(
    `[curriculum-search] trigram fallback — returning ${merged.length} chunks:`,
    merged.map((c) => `chunk#${c.chunkIndex} pages ${c.pageRange}`)
  );

  return merged;
}
