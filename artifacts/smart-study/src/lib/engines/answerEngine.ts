/**
 * ANSWER ENGINE — Strict RAG-Only Answering
 *
 * Responsibility:
 *   Given a student question + curriculum context, retrieve relevant curriculum
 *   chunks via RAG and produce a grounded answer using ONLY that retrieved material.
 *
 * Hard Rules (enforced in code, not just prompt):
 *   - MUST retrieve curriculum context before any Gemini call
 *   - If retrieval returns no chunks → return fixed Arabic message, NO Gemini call
 *   - Gemini is ONLY called when relevant context exists
 *   - System prompt forbids all general-knowledge and model-memory answering
 *   - NEVER generates flashcards or detects weaknesses
 *   - NEVER calls other engines
 */

import { searchCurriculum, formatCurriculumContext } from '../../utils/curriculumSearch';
import type { ConversationMessage, CurriculumContext } from '../../utils/ai';
import { resolveModel } from './modelResolver';

/**
 * Returned verbatim when no curriculum context is found.
 * Gemini is NOT called in this case.
 */
export const NO_CONTEXT_RESPONSE =
  'عذراً، هذه المعلومة غير متوفرة في كتاب المنهج المعتمد المرفوع حالياً.';

/**
 * Returned verbatim when no subject has been selected yet.
 * Mirrors the existing subject-locking behavior in buildSystemPrompt (utils/ai.ts).
 * Gemini is NOT called and RAG is NOT run in this case.
 */
export const NO_SUBJECT_RESPONSE =
  'لم تختر مادةً بعد. يرجى اختيار المادة الدراسية أولاً من قائمة المواد المتاحة حتى أتمكن من مساعدتك.';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AnswerRequest {
  message: string;
  history: ConversationMessage[];
  curriculum: CurriculumContext;
}

export interface AnswerResult {
  text: string;
  ragChunksFound: number;
  retrievedContext: string | null;
  modelUsed: string;
  /**
   * True when no subject is selected. Gemini and RAG are NOT called.
   * The text field will equal NO_SUBJECT_RESPONSE in this case.
   */
  noSubject: boolean;
  /**
   * True when retrieval returned no chunks and Gemini was NOT called.
   * The text field will equal NO_CONTEXT_RESPONSE in this case.
   */
  noContext: boolean;
}

export type AnswerEngineError =
  | { code: 'NO_API_KEY' }
  | { code: 'QUOTA_EXCEEDED' }
  | { code: 'EMPTY_RESPONSE' }
  | { code: 'NETWORK_ERROR'; detail: string };

export { resolveModel } from './modelResolver';

export function resetModelCache(): void {
  // No-op: cache is managed by the shared modelResolver module.
  // Kept for API compatibility.
}

// ─── RAG Retrieval ────────────────────────────────────────────────────────────

/**
 * Retrieve grounding context from the curriculum index.
 * Returns null if curriculum is incomplete or no chunks are found.
 * This is the ONLY source of truth for answering.
 */
async function retrieveContext(
  curriculum: CurriculumContext,
  query: string
): Promise<{ chunks: number; formatted: string } | null> {
  if (!curriculum.country || !curriculum.level || !curriculum.subject) return null;
  try {
    const chunks = await searchCurriculum(
      curriculum.country,
      curriculum.level,
      curriculum.subject,
      query,
      10
    );
    if (!chunks.length) return null;
    return { chunks: chunks.length, formatted: formatCurriculumContext(chunks) };
  } catch {
    return null;
  }
}

// ─── Strict RAG System Prompt ─────────────────────────────────────────────────

/**
 * Build a system prompt that enforces strict retrieval-grounded answering.
 * Contains NO academic fallback, NO general knowledge allowance.
 * Only called when ragContext is non-null.
 */
function buildStrictRAGPrompt(
  curriculum: CurriculumContext,
  ragContext: string
): string {
  const countryLabel =
    curriculum.country === 'egypt' ? 'مصر' :
    curriculum.country === 'sudan' ? 'السودان' :
    curriculum.country;

  const levelLabel =
    curriculum.level === 'primary' ? 'المرحلة الابتدائية' :
    curriculum.level === 'preparatory' ? 'المرحلة الإعدادية' :
    curriculum.level === 'secondary' ? 'المرحلة الثانوية' :
    curriculum.level;

  return `أنت Sage — مساعد تعليمي يعمل بنظام RAG صارم.

==================================================
النطاق المحدد (غير قابل للتغيير)
==================================================
- الدولة: ${countryLabel}
- المرحلة: ${levelLabel}
- المادة المفعّلة: ${curriculum.subject}
- المسار: ${curriculum.track || 'غير محدد'}

==================================================
مصدر الإجابة الوحيد المسموح به
==================================================
المقاطع أدناه مُستخرجة من الكتاب المدرسي الرسمي المعتمد للمادة المحددة فقط.

${ragContext}

==================================================
قواعد صارمة غير قابلة للتجاوز
==================================================
1. أجب فقط بناءً على المقاطع المُستخرجة أعلاه.
2. إذا كانت الإجابة غير موجودة في المقاطع المُستخرجة — قل: "عذراً، هذه المعلومة غير متوفرة في كتاب المنهج المعتمد المرفوع حالياً."
3. لا تستخدم ذاكرة النموذج أو المعرفة العامة إطلاقاً.
4. لا تستنتج أو تكمل معلومات غير موجودة في النص.
5. إذا كان السؤال يخص مادةً أخرى غير "${curriculum.subject}" — ارفض الإجابة وأخبر الطالب بلطف أن هذا خارج نطاق المادة المختارة.
6. لا تتعامل مع أسئلة تخص دولة أو مرحلة أو مساراً مختلفاً عما هو محدد أعلاه.
7. لا تذكر مصادر خارجية أو كتباً أخرى.

==================================================
أسلوب الإجابة
==================================================
- أجب بالعربية الفصحى الواضحة المناسبة للطالب.
- استخدم markdown للتنسيق واللاتكس للمعادلات.
- اجعل الإجابة مختصرة ومركزة.
- اقتبس من النص الأصلي عند الضرورة.`;
}

// ─── Gemini Call (via backend proxy) ──────────────────────────────────────────

async function callGemini(
  modelId: string,
  systemPrompt: string,
  history: ConversationMessage[],
  userMessage: string
): Promise<string> {
  const contents: ConversationMessage[] = [
    ...history,
    { role: 'user', parts: [{ text: userMessage }] },
  ];

  const attempt1 = async () => {
    const res = await fetch('/api/gemini/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelId,
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents,
        generationConfig: { maxOutputTokens: 1024, temperature: 0.3 },
      }),
    });
    // Read body as text first — prevents "Unexpected token '<'" if server returns HTML error page
    const raw = await res.text();
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const errJson = JSON.parse(raw);
        msg = errJson?.error?.message ?? errJson?.error ?? msg;
      } catch { /* raw is not JSON (e.g. HTML from 413/502) — use status code */ }
      if (
        res.status === 429 ||
        msg.toLowerCase().includes('quota') ||
        msg.toLowerCase().includes('resource_exhausted')
      ) {
        throw Object.assign(new Error(String(msg)), { code: 'QUOTA_EXCEEDED' });
      }
      if (msg.toLowerCase().includes('not found')) resetModelCache();
      throw new Error(String(msg));
    }
    const data = JSON.parse(raw);
    const text: string = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    if (!text) throw new Error('EMPTY_RESPONSE');
    return text;
  };

  const attempt2 = async () => {
    const res = await fetch('/api/gemini/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelId,
        contents: [
          { role: 'user', parts: [{ text: systemPrompt }] },
          { role: 'model', parts: [{ text: 'مفهوم. سأجيب فقط من المقاطع المُستخرجة.' }] },
          ...history,
          { role: 'user', parts: [{ text: userMessage }] },
        ],
        generationConfig: { maxOutputTokens: 1024, temperature: 0.3 },
      }),
    });
    const raw = await res.text();
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { msg = (JSON.parse(raw) as { error?: { message?: string }; message?: string })?.error?.message ?? msg; } catch { /* not JSON */ }
      throw new Error(String(msg));
    }
    const data = JSON.parse(raw);
    const text: string = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    if (!text) throw new Error('EMPTY_RESPONSE');
    return text;
  };

  try {
    return await attempt1();
  } catch (err: unknown) {
    if (err instanceof Error && (err as { code?: string }).code === 'QUOTA_EXCEEDED') throw err;
    return await attempt2();
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Answer a student question using STRICT RAG-only grounding.
 *
 * Hard gate enforced in code:
 *   - If RAG retrieval returns no chunks → Gemini is NOT called.
 *     Returns NO_CONTEXT_RESPONSE with noContext: true.
 *   - If RAG retrieval returns chunks → Gemini is called with a strict
 *     prompt that forbids any use of general knowledge.
 *
 * @throws Error with code 'NO_API_KEY' | 'QUOTA_EXCEEDED' | 'EMPTY_RESPONSE'
 */
export async function answerQuestion(req: AnswerRequest): Promise<AnswerResult> {
  // ── GATE 1: Subject validation ─────────────────────────────────────────────
  if (!req.curriculum.subject) {
    return {
      text: NO_SUBJECT_RESPONSE,
      ragChunksFound: 0,
      retrievedContext: null,
      modelUsed: 'none',
      noSubject: true,
      noContext: false,
    };
  }
  // ──────────────────────────────────────────────────────────────────────────

  // Step 1 — RAG retrieval (runs in parallel with model discovery)
  const [modelId, ragResult] = await Promise.all([
    resolveModel(),
    retrieveContext(req.curriculum, req.message),
  ]);

  // ── GATE 2: Context existence check ───────────────────────────────────────
  if (!ragResult) {
    return {
      text: NO_CONTEXT_RESPONSE,
      ragChunksFound: 0,
      retrievedContext: null,
      modelUsed: 'none',
      noSubject: false,
      noContext: true,
    };
  }
  // ──────────────────────────────────────────────────────────────────────────

  // Step 2 — Build strict RAG-only system prompt (subject + country + level locked)
  const systemPrompt = buildStrictRAGPrompt(req.curriculum, ragResult.formatted);

  // Step 3 — Call Gemini via backend proxy with retrieved context only
  const text = await callGemini(
    modelId,
    systemPrompt,
    req.history,
    req.message
  );

  return {
    text,
    ragChunksFound: ragResult.chunks,
    retrievedContext: ragResult.formatted,
    modelUsed: modelId,
    noSubject: false,
    noContext: false,
  };
}
