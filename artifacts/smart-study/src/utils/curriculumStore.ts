import type { CurriculumDocument, CurriculumChunk } from '../data/curriculum/types';
import { LEVEL_GRADE_MAP } from '../data/curriculum/types';

const STORAGE_KEY = 'sage-curriculum-v1';

function loadAll(): CurriculumDocument[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as CurriculumDocument[]) : [];
  } catch {
    return [];
  }
}

function saveAll(docs: CurriculumDocument[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(docs));
}

export function getAllCurriculumDocs(): CurriculumDocument[] {
  return loadAll();
}

export function saveCurriculumDoc(doc: CurriculumDocument): void {
  const docs = loadAll().filter((d) => d.id !== doc.id);
  saveAll([...docs, doc]);
}

export function deleteCurriculumDoc(id: string): void {
  saveAll(loadAll().filter((d) => d.id !== id));
}

export function getCurriculumChunks(
  country: string,
  level: string,
  subject: string
): CurriculumChunk[] {
  const validGrades = new Set(LEVEL_GRADE_MAP[level] ?? []);
  const docs = loadAll().filter(
    (d) =>
      d.country === country &&
      d.subject === subject &&
      validGrades.has(d.grade)
  );
  return docs.flatMap((d) => d.chunks);
}

export function hasCurriculum(country: string, level: string, subject: string): boolean {
  return getCurriculumChunks(country, level, subject).length > 0;
}

export function getCurriculumStorageSizeKB(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) ?? '';
    return Math.round((raw.length * 2) / 1024);
  } catch {
    return 0;
  }
}
