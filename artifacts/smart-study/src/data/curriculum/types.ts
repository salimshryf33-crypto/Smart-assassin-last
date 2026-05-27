export interface CurriculumChunk {
  id: string;
  country: string;
  grade: string;
  subject: string;
  chapter: string;
  pageRange: string;
  content: string;
  keywords: string[];
}

export interface CurriculumDocument {
  id: string;
  country: string;
  grade: string;
  subject: string;
  filename: string;
  uploadedAt: number;
  totalPages: number;
  chunks: CurriculumChunk[];
}

export const GRADE_OPTIONS: { value: string; label: string; level: string }[] = [
  { value: 'grade1', label: 'الصف الأول', level: 'primary' },
  { value: 'grade2', label: 'الصف الثاني', level: 'primary' },
  { value: 'grade3', label: 'الصف الثالث', level: 'primary' },
  { value: 'grade4', label: 'الصف الرابع', level: 'primary' },
  { value: 'grade5', label: 'الصف الخامس', level: 'primary' },
  { value: 'grade6', label: 'الصف السادس', level: 'primary' },
  { value: 'grade7', label: 'الصف السابع', level: 'preparatory' },
  { value: 'grade8', label: 'الصف الثامن', level: 'preparatory' },
  { value: 'grade9', label: 'الصف التاسع', level: 'preparatory' },
  { value: 'grade10', label: 'الصف العاشر', level: 'secondary' },
  { value: 'grade11', label: 'الصف الحادي عشر', level: 'secondary' },
  { value: 'grade12', label: 'الصف الثاني عشر', level: 'secondary' },
];

export const LEVEL_GRADE_MAP: Record<string, string[]> = {
  primary: ['grade1', 'grade2', 'grade3', 'grade4', 'grade5', 'grade6'],
  preparatory: ['grade7', 'grade8', 'grade9'],
  secondary: ['grade10', 'grade11', 'grade12'],
};
