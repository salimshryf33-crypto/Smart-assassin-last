/**
 * Display-only exam title helpers.
 *
 * Exam records remain unchanged. A suffix is added only when the same title
 * occurs more than once in the response being rendered.
 */

export interface ExamDisplayRecord {
  examId: string;
  title: string | null;
  createdAt?: Date | string | null;
}

function shortDate(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

export function disambiguateExamTitles<T extends ExamDisplayRecord>(records: T[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const record of records) {
    const title = record.title ?? record.examId;
    counts.set(title, (counts.get(title) ?? 0) + 1);
  }

  const result = new Map<string, string>();
  for (const record of records) {
    const title = record.title ?? record.examId;
    if ((counts.get(title) ?? 0) < 2) {
      result.set(record.examId, title);
      continue;
    }

    const suffix = shortDate(record.createdAt) ?? record.examId.slice(-6);
    result.set(record.examId, `${title} · ${suffix}`);
  }
  return result;
}