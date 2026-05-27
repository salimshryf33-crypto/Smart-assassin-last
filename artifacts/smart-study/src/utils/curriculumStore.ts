export { getCurriculumDocs, deleteCurriculumDoc } from './curriculumApi';

export async function hasCurriculum(country: string, _level: string, _subject: string): Promise<boolean> {
  if (!country) return false;
  try {
    const { getCurriculumDocs } = await import('./curriculumApi');
    const docs = await getCurriculumDocs();
    return docs.some((d) => d.country === country && d.status === 'done');
  } catch {
    return false;
  }
}
