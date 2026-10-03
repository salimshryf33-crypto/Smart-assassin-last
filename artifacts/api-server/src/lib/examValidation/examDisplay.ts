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

export function disambiguateExamTitles<T extends ExamDisplayRecord>(records: T[]): Map<string, string> {
  // The same exam can appear in more than one dashboard section. Count unique
  // exams, not repeated rows, or a single exam would be labeled as a duplicate.
  const uniqueRecords = new Map<string, T>();
  for (const record of records) uniqueRecords.set(record.examId, record);

  const byTitle = new Map<string, T[]>();
  for (const record of uniqueRecords.values()) {
    const title = record.title ?? record.examId;
    const group = byTitle.get(title) ?? [];
    group.push(record);
    byTitle.set(title, group);
  }

  const result = new Map<string, string>();
  for (const [title, group] of byTitle) {
    if (group.length === 1) {
      result.set(group[0].examId, title);
    } else {
      // Use IDs rather than dates: duplicate exams may have identical creation
      // timestamps, but their IDs still identify the records.
      let suffixLength = Math.min(6, ...group.map((record) => record.examId.length));
      const suffixes = () => group.map((record) => record.examId.slice(-suffixLength));
      while (new Set(suffixes()).size !== group.length && suffixLength < Math.max(...group.map((record) => record.examId.length))) {
        suffixLength++;
      }
      for (const record of group) {
        result.set(record.examId, `${title} · ${record.examId.slice(-suffixLength)}`);
      }
    }
  }
  return result;
}