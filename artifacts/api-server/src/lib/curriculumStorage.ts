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
  embedding?: number[]; // reserved for future vector search
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

export function searchChunks(
  country: string,
  grade: string,
  subject: string,
  query: string,
  topK = 3
): CurriculumChunk[] {
  const LEVEL_GRADE_MAP: Record<string, string[]> = {
    primary: ['grade1', 'grade2', 'grade3', 'grade4', 'grade5', 'grade6'],
    preparatory: ['grade7', 'grade8', 'grade9'],
    secondary: ['grade10', 'grade11', 'grade12'],
  };

  const validGrades = new Set<string>(LEVEL_GRADE_MAP[grade] ?? [grade]);

  const docs = readIndex().filter(
    (d) =>
      d.status === 'done' &&
      d.country === country &&
      d.subject === subject &&
      validGrades.has(d.grade)
  );

  if (docs.length === 0) return [];

  const allChunks = docs.flatMap((d) => loadChunks(d.id));
  if (allChunks.length === 0) return [];

  if (!query.trim()) return allChunks.slice(0, topK);

  const stopWords = new Set([
    'في', 'من', 'إلى', 'على', 'أن', 'هذا', 'هذه', 'التي', 'الذي', 'كان',
    'بين', 'ما', 'هو', 'هي', 'لا', 'عن', 'مع', 'بعد', 'قبل', 'كل',
    'the', 'and', 'of', 'to', 'a', 'in', 'is', 'are', 'was', 'for',
  ]);

  const tokenize = (t: string) =>
    new Set(
      t.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/)
        .filter((w) => w.length > 2 && !stopWords.has(w))
    );

  const queryTokens = tokenize(query);

  const scored = allChunks.map((chunk) => {
    let score = 0;
    const contentTokens = tokenize(chunk.content);
    for (const qt of queryTokens) {
      if (contentTokens.has(qt)) score += 2;
      if (chunk.keywords.includes(qt)) score += 3;
      if (chunk.chapter.toLowerCase().includes(qt)) score += 5;
    }
    return { chunk, score };
  });

  return scored
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((r) => r.chunk);
}
