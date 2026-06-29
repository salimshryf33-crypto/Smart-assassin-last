/**
 * EXAM CONTEXT BUILDER — EXAM_MODE Frontend Service
 *
 * Fetches weakness-targeted exam questions from the backend chat-context endpoint
 * and formats them into a Gemini-ready prompt section.
 *
 * Used exclusively by answerEngine.ts when mode === EXAM_MODE.
 * Never calls Gemini directly. Never modifies exam bank data.
 */

import { getAppCheckToken } from '../appCheckToken';
import type { CurriculumContext } from '../../utils/ai';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ExamQuestion {
  id: string;
  question: string;
  questionType: string;
  options?: Record<string, string> | null;
  correctAnswer?: string | null;
  explanation?: string | null;
  topic?: string | null;
  year?: string | null;
  difficulty?: string | null;
  sourceExamTitle: string;
}

export interface ExamChatContext {
  weakTopics: string[];
  questions: ExamQuestion[];
  hasWeaknessData: boolean;
  /** Ready-to-embed section for the Gemini system prompt */
  formattedContext: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function buildHeaders(): Promise<HeadersInit> {
  const token = await getAppCheckToken();
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) h['X-Firebase-AppCheck'] = token;
  return h;
}

function formatQuestions(questions: ExamQuestion[]): string {
  if (questions.length === 0) return 'لا توجد أسئلة في بنك الامتحانات لهذه المادة حالياً.';

  return questions.map((q, i) => {
    const lines: string[] = [];

    const header = [`[سؤال ${i + 1}]`];
    if (q.topic)      header.push(`موضوع: ${q.topic}`);
    if (q.year)       header.push(q.year);
    if (q.difficulty) header.push(`صعوبة: ${q.difficulty}`);
    lines.push(header.join(' | '));

    lines.push(q.question);

    if (q.options && typeof q.options === 'object') {
      Object.entries(q.options).forEach(([k, v]) => lines.push(`  ${k}) ${v}`));
    }

    lines.push(`✓ الإجابة الصحيحة: ${q.correctAnswer ?? '—'}`);
    if (q.explanation) lines.push(`📖 الشرح: ${q.explanation}`);

    return lines.join('\n');
  }).join('\n\n---\n\n');
}

function buildFormattedContext(data: Omit<ExamChatContext, 'formattedContext'>): string {
  const sections: string[] = [];

  // Section 1 — Weakness profile
  if (data.hasWeaknessData && data.weakTopics.length > 0) {
    const topList = data.weakTopics.slice(0, 6).map((t, i) => `${i + 1}. ${t}`).join('\n');
    sections.push(`══ نقاط الضعف المرصودة (مرتبة من الأضعف) ══\n${topList}`);
  } else {
    sections.push('══ لا توجد بيانات امتحانات سابقة — سيتم اختيار أسئلة متنوعة ══');
  }

  // Section 2 — Exam questions with answers (for tutor use)
  sections.push(
    `══ بنك أسئلة الامتحانات (للمدرس فقط — لا تكشف الإجابات مباشرةً) ══\n${formatQuestions(data.questions)}`
  );

  return sections.join('\n\n');
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch weakness-targeted exam context for the Socratic Tutor.
 * Returns null on network/auth failure — caller falls back gracefully.
 */
export async function fetchExamContext(
  curriculum: CurriculumContext
): Promise<ExamChatContext | null> {
  try {
    const params = new URLSearchParams();
    if (curriculum.country) params.set('country', curriculum.country);
    if (curriculum.level)   params.set('grade',   curriculum.level);
    if (curriculum.subject) params.set('subject',  curriculum.subject);

    const res = await fetch(`/api/exams/chat-context?${params.toString()}`, {
      headers: await buildHeaders(),
    });

    if (!res.ok) return null;

    const data = await res.json() as {
      weakTopics: string[];
      questions: ExamQuestion[];
      hasWeaknessData: boolean;
    };

    const formattedContext = buildFormattedContext(data);
    return { ...data, formattedContext };
  } catch {
    return null;
  }
}
