import { Country, Level, Track } from '../store/useAppStore';

export interface SubjectOption {
  id: string;
  label: string;
  icon: string;
}

const EGYPT_PRIMARY: SubjectOption[] = [
  { id: 'arabic', label: 'اللغة العربية', icon: '📖' },
  { id: 'math', label: 'الرياضيات', icon: '🔢' },
  { id: 'science', label: 'العلوم', icon: '🔬' },
  { id: 'social', label: 'الدراسات الاجتماعية', icon: '🌍' },
  { id: 'english', label: 'اللغة الإنجليزية', icon: '🇬🇧' },
  { id: 'religion', label: 'التربية الدينية', icon: '📿' },
];

const EGYPT_PREPARATORY: SubjectOption[] = [
  { id: 'arabic', label: 'اللغة العربية', icon: '📖' },
  { id: 'math', label: 'الرياضيات', icon: '🔢' },
  { id: 'science', label: 'العلوم', icon: '🔬' },
  { id: 'english', label: 'اللغة الإنجليزية', icon: '🇬🇧' },
  { id: 'social', label: 'الدراسات الاجتماعية', icon: '🌍' },
  { id: 'religion', label: 'التربية الدينية', icon: '📿' },
];

const EGYPT_SECONDARY_SCIENTIFIC: SubjectOption[] = [
  { id: 'arabic', label: 'اللغة العربية', icon: '📖' },
  { id: 'math', label: 'الرياضيات', icon: '🔢' },
  { id: 'physics', label: 'الفيزياء', icon: '⚛️' },
  { id: 'chemistry', label: 'الكيمياء', icon: '🧪' },
  { id: 'biology', label: 'الأحياء', icon: '🧬' },
  { id: 'english', label: 'اللغة الإنجليزية', icon: '🇬🇧' },
  { id: 'history', label: 'التاريخ', icon: '🏛️' },
  { id: 'geography', label: 'الجغرافيا', icon: '🗺️' },
];

const EGYPT_SECONDARY_LITERARY: SubjectOption[] = [
  { id: 'arabic', label: 'اللغة العربية', icon: '📖' },
  { id: 'math', label: 'الرياضيات', icon: '🔢' },
  { id: 'history', label: 'التاريخ', icon: '🏛️' },
  { id: 'geography', label: 'الجغرافيا', icon: '🗺️' },
  { id: 'philosophy', label: 'الفلسفة والمنطق', icon: '🧠' },
  { id: 'english', label: 'اللغة الإنجليزية', icon: '🇬🇧' },
  { id: 'religion', label: 'التربية الدينية', icon: '📿' },
  { id: 'sociology', label: 'علم النفس والاجتماع', icon: '👥' },
];

const SUDAN_PRIMARY: SubjectOption[] = [
  { id: 'arabic', label: 'اللغة العربية', icon: '📖' },
  { id: 'math', label: 'الرياضيات', icon: '🔢' },
  { id: 'science', label: 'العلوم العامة', icon: '🔬' },
  { id: 'social', label: 'الدراسات الاجتماعية', icon: '🌍' },
  { id: 'english', label: 'اللغة الإنجليزية', icon: '🇬🇧' },
  { id: 'religion', label: 'التربية الإسلامية', icon: '📿' },
];

const SUDAN_PREPARATORY: SubjectOption[] = [
  { id: 'arabic', label: 'اللغة العربية', icon: '📖' },
  { id: 'math', label: 'الرياضيات', icon: '🔢' },
  { id: 'science', label: 'العلوم', icon: '🔬' },
  { id: 'english', label: 'اللغة الإنجليزية', icon: '🇬🇧' },
  { id: 'social', label: 'الدراسات الاجتماعية', icon: '🌍' },
  { id: 'religion', label: 'التربية الإسلامية', icon: '📿' },
];

const SUDAN_SECONDARY_SCIENTIFIC: SubjectOption[] = [
  { id: 'arabic', label: 'اللغة العربية', icon: '📖' },
  { id: 'math', label: 'الرياضيات', icon: '🔢' },
  { id: 'physics', label: 'الفيزياء', icon: '⚛️' },
  { id: 'chemistry', label: 'الكيمياء', icon: '🧪' },
  { id: 'biology', label: 'الأحياء', icon: '🧬' },
  { id: 'english', label: 'اللغة الإنجليزية', icon: '🇬🇧' },
];

const SUDAN_SECONDARY_LITERARY: SubjectOption[] = [
  { id: 'arabic', label: 'اللغة العربية', icon: '📖' },
  { id: 'history', label: 'التاريخ', icon: '🏛️' },
  { id: 'geography', label: 'الجغرافيا', icon: '🗺️' },
  { id: 'economics', label: 'الاقتصاد', icon: '📊' },
  { id: 'english', label: 'اللغة الإنجليزية', icon: '🇬🇧' },
  { id: 'religion', label: 'التربية الإسلامية', icon: '📿' },
];

export function getSubjects(
  country: Country | '',
  level: Level | '',
  track: Track | ''
): SubjectOption[] {
  if (!country || !level) return [];

  if (country === 'egypt') {
    if (level === 'primary') return EGYPT_PRIMARY;
    if (level === 'preparatory') return EGYPT_PREPARATORY;
    if (level === 'secondary') {
      return track === 'literary' ? EGYPT_SECONDARY_LITERARY : EGYPT_SECONDARY_SCIENTIFIC;
    }
  }

  if (country === 'sudan') {
    if (level === 'primary') return SUDAN_PRIMARY;
    if (level === 'preparatory') return SUDAN_PREPARATORY;
    if (level === 'secondary') {
      return track === 'literary' ? SUDAN_SECONDARY_LITERARY : SUDAN_SECONDARY_SCIENTIFIC;
    }
  }

  return [];
}

export function getSubjectLabel(subjects: SubjectOption[], id: string | null): string {
  if (!id) return '';
  return subjects.find((s) => s.id === id)?.label ?? id;
}
