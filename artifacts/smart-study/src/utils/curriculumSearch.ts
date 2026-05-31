import { searchCurriculumApi, type CurriculumChunk } from './curriculumApi';

export type { CurriculumChunk };

export async function searchCurriculum(
  country: string,
  level: string,
  subject: string,
  query: string,
  topK = 5
): Promise<CurriculumChunk[]> {
  try {
    return await searchCurriculumApi(country, level, subject, query, topK);
  } catch {
    return [];
  }
}

export function formatCurriculumContext(chunks: CurriculumChunk[]): string {
  if (chunks.length === 0) return '';
  const sections = chunks.map(
    (c, i) =>
      `--- [قسم ${i + 1}: ${c.chapter} | صفحات ${c.pageRange}] ---\n${c.content}`
  );
  return `\n\n==================================================\nCURRICULUM REFERENCE MATERIAL\n==================================================\nThe following is extracted directly from the official textbook. Use it as your primary teaching source:\n\n${sections.join('\n\n')}\n==================================================`;
}
