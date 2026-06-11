/**
 * examGenerator — AI-powered exam generation from curriculum chunks.
 *
 * Uses curriculumStorage (UNCHANGED) to load chunks, then calls Gemini
 * to generate structured questions, and persists via IExamQuestionStore.
 *
 * Architecture rule: reads curriculum via curriculumStorage,
 * writes exam data via examStore only.
 */
import { v4 as uuidv4 } from 'uuid';
import { searchChunks } from './curriculumStorage';
import { examStore } from './examStore';
import { logger } from './logger';
import type { InsertExamRecord, InsertExamQuestion } from '@workspace/db';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com';

// ─── Gemini helper ────────────────────────────────────────────────────────────

async function callGemini(prompt: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');
  const res = await fetch(
    `${GEMINI_BASE}/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 4096, temperature: 0.4 },
      }),
    }
  );
  if (!res.ok) throw new Error(`Gemini ${res.status}`);
  const data = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}

// ─── Generation prompt ────────────────────────────────────────────────────────

function buildGenerationPrompt(
  chunks: string[],
  opts: GenerateExamOptions
): string {
  const context = chunks.slice(0, 6).join('\n\n---\n\n');
  const typeBreakdown = opts.typeBreakdown
    ? JSON.stringify(opts.typeBreakdown)
    : `{ "mcq": ${Math.ceil(opts.count * 0.6)}, "short_answer": ${Math.floor(opts.count * 0.3)}, "essay": ${Math.floor(opts.count * 0.1)} }`;

  return `أنت أستاذ خبير تُنشئ امتحاناً تعليمياً للمنهج العربي.

أنشئ ${opts.count} سؤالاً من مستويات صعوبة متنوعة بناءً على المحتوى أدناه.
توزيع الأنواع المطلوب: ${typeBreakdown}

${opts.chapter ? `الفصل/الموضوع: ${opts.chapter}` : ''}
${opts.topic ? `الموضوع المحدد: ${opts.topic}` : ''}
المرحلة: ${opts.grade} — المادة: ${opts.subject}

أعد مصفوفة JSON فقط، كل عنصر:
{
  "question": "<نص السؤال>",
  "questionType": "mcq" | "true_false" | "short_answer" | "essay" | "calculation",
  "options": ["أ) ...", "ب) ...", "ج) ...", "د) ..."] أو null,
  "correctAnswer": "<الإجابة>" أو null,
  "explanation": "<شرح الإجابة>" أو null,
  "topic": "<الموضوع الفرعي>",
  "chapter": "<الفصل>",
  "difficulty": "easy" | "medium" | "hard"
}

قواعد:
- الأسئلة متنوعة تغطي أجزاء مختلفة من المحتوى.
- MCQ لها 4 خيارات دائماً.
- true_false تكون عبارة وليست سؤالاً.
- أعد JSON فقط بدون markdown أو شرح.

محتوى المنهج:
${context}`;
}

// ─── Parser ───────────────────────────────────────────────────────────────────

interface ParsedQuestion {
  question:      string;
  questionType:  string;
  options:       string[] | null;
  correctAnswer: string | null;
  explanation:   string | null;
  topic:         string | null;
  chapter:       string | null;
  difficulty:    string | null;
}

function parseGeneratedQuestions(raw: string): ParsedQuestion[] {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    const parsed = JSON.parse(cleaned) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (q): q is ParsedQuestion =>
        typeof q === 'object' && q !== null &&
        typeof (q as Record<string, unknown>).question === 'string' &&
        (q as Record<string, unknown>).question !== ''
    );
  } catch {
    return [];
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface GenerateExamOptions {
  country:      string;
  grade:        string;
  subject:      string;
  track?:       string;
  chapter?:     string;
  topic?:       string;
  year?:        string;
  examType?:    string;
  organization?: string;
  count:        number;        // target question count (max 30)
  title?:       string;
  ownerId:      string | null; // null = public (admin)
  visibility:   'public' | 'private';
  typeBreakdown?: Record<string, number>; // e.g. { mcq: 10, short_answer: 3, essay: 2 }
  bookTitle?:   string;
}

export interface GenerateExamResult {
  examId:         string;
  title:          string;
  questionCount:  number;
}

export async function generateExam(opts: GenerateExamOptions): Promise<GenerateExamResult> {
  const count = Math.min(opts.count, 30);
  const examId = uuidv4();
  const title = opts.title?.trim() || `امتحان ${opts.subject} — ${opts.grade} (${opts.year ?? new Date().getFullYear()})`;

  // ── Load relevant curriculum chunks ─────────────────────────────────────────
  const chunks = searchChunks(
    opts.country,
    opts.grade,
    opts.subject,
    opts.topic ?? opts.chapter ?? '',
    12
  );

  if (chunks.length === 0) {
    throw new Error(
      `لا توجد بيانات منهجية لـ country=${opts.country} grade=${opts.grade} subject=${opts.subject}. ` +
      `يرجى رفع كتاب المادة أولاً.`
    );
  }

  const chunkTexts = chunks.map((c) => c.content);

  // ── Create exam record (pending) ─────────────────────────────────────────────
  const record: InsertExamRecord = {
    examId,
    curriculumDocId:  chunks[0]?.docId ?? examId,
    title,
    bookTitle:        opts.bookTitle ?? null,
    subject:          opts.subject,
    grade:            opts.grade,
    country:          opts.country,
    track:            opts.track ?? '',
    year:             opts.year ?? String(new Date().getFullYear()),
    examType:         opts.examType ?? 'practice',
    organization:     opts.organization ?? null,
    ownerId:          opts.ownerId,
    visibility:       opts.visibility,
    questionCount:    0,
    extractionStatus: 'extracting',
    extractionError:  null,
    extractedAt:      null,
  };
  await examStore.upsertExamRecord(record);

  try {
    // ── Call Gemini ──────────────────────────────────────────────────────────
    const raw = await callGemini(buildGenerationPrompt(chunkTexts, { ...opts, count }));
    const parsed = parseGeneratedQuestions(raw);

    if (parsed.length === 0) {
      throw new Error('Gemini returned no parseable questions');
    }

    // ── Build InsertExamQuestion[] ──────────────────────────────────────────
    const questions: InsertExamQuestion[] = parsed.map((q, idx) => ({
      id:               uuidv4(),
      examId,
      question:         q.question,
      questionType:     q.questionType ?? 'short_answer',
      options:          q.options ?? null,
      correctAnswer:    q.correctAnswer ?? null,
      explanation:      q.explanation ?? null,
      topic:            q.topic ?? opts.topic ?? null,
      chapter:          q.chapter ?? opts.chapter ?? null,
      subject:          opts.subject,
      grade:            opts.grade,
      country:          opts.country,
      year:             opts.year ?? null,
      examType:         opts.examType ?? 'practice',
      difficulty:       q.difficulty ?? null,
      organization:     opts.organization ?? null,
      sourceExamId:     examId,
      sourceExamTitle:  title,
      questionOrder:    idx + 1,
    }));

    await examStore.saveQuestions(questions);

    // ── Mark done ────────────────────────────────────────────────────────────
    await examStore.upsertExamRecord({
      ...record,
      questionCount:    questions.length,
      extractionStatus: 'done',
      extractedAt:      new Date(),
    });

    logger.info({ examId, title, questionCount: questions.length }, 'examGenerator: exam created');

    return { examId, title, questionCount: questions.length };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await examStore.upsertExamRecord({
      ...record,
      extractionStatus: 'error',
      extractionError:  msg,
    });
    throw err;
  }
}
