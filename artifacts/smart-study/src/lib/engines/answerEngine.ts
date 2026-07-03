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
import { getAppCheckToken } from '../appCheckToken';
import { type ContextMode, type ContextObject, buildContextObject, DEFAULT_MODE } from './contextMode';
import { fetchExamContext, type ExamChatContext } from './examContextBuilder';
import { buildQuizPrompt, NO_QUIZ_CONTENT_RESPONSE } from './quizEngine';
import {
  type StudentLearningContext,
  formatStudentContextSection,
} from './studentContextBuilder';

async function geminiHeaders(): Promise<HeadersInit> {
  const acToken = await getAppCheckToken();
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (acToken) h['X-Firebase-AppCheck'] = acToken;
  return h;
}

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
  /**
   * The active Context Mode for this request.
   * Defaults to BOOK_MODE when not provided (backward compatible).
   */
  mode?: ContextMode;
  /**
   * Phase 3 — Temporary student learning context.
   *
   * Built from existing Sage data (flashcard weakness profile) by the
   * orchestrator BEFORE calling the answer engine. Lives only for the
   * duration of this request — never stored permanently.
   *
   * Optional / backward-compatible: if absent the prompt is unchanged.
   */
  studentContext?: StudentLearningContext;
}

export type { ContextMode, ContextObject };

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
 *
 * Phase 3: optional studentContext appended when available.
 * The context section adds personalisation hints (depth, weak topics, optional
 * recommendation guidance) without relaxing any RAG-grounding rules.
 */
function buildStrictRAGPrompt(
  curriculum: CurriculumContext,
  ragContext: string,
  studentContext?: StudentLearningContext
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
- اقتبس من النص الأصلي عند الضرورة.${studentContext ? (formatStudentContextSection(studentContext) ?? '') : ''}`;
}

// ─── Gemini Call (via backend proxy) ──────────────────────────────────────────

async function callGemini(
  modelId: string,
  systemPrompt: string,
  history: ConversationMessage[],
  userMessage: string,
  mode: ContextMode = DEFAULT_MODE
): Promise<string> {
  const contents: ConversationMessage[] = [
    ...history,
    { role: 'user', parts: [{ text: userMessage }] },
  ];

  const attempt1 = async () => {
    const res = await fetch('/api/gemini/generate', {
      method: 'POST',
      headers: await geminiHeaders(),
      body: JSON.stringify({
        model: modelId,
        mode,
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
      headers: await geminiHeaders(),
      body: JSON.stringify({
        model: modelId,
        mode,
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

// ─── EXAM_MODE: Socratic Tutor Prompt ────────────────────────────────────────

/**
 * Build a Socratic tutor system prompt that blends:
 *   - Weakness-targeted exam questions (from exam bank)
 *   - Curriculum RAG context (for explanations when student answers wrong)
 *
 * The model acts as a tutor, not a search engine.
 * It presents one question at a time and evaluates student answers.
 */
function buildExamTutorPrompt(
  curriculum: CurriculumContext,
  examCtx: ExamChatContext | null,
  ragContext: string | null
): string {
  const countryLabel =
    curriculum.country === 'egypt'  ? 'مصر'     :
    curriculum.country === 'sudan'  ? 'السودان' :
    curriculum.country ?? 'غير محدد';

  const levelLabel =
    curriculum.level === 'primary'      ? 'المرحلة الابتدائية' :
    curriculum.level === 'preparatory'  ? 'المرحلة الإعدادية'  :
    curriculum.level === 'secondary'    ? 'المرحلة الثانوية'   :
    curriculum.level ?? 'غير محدد';

  const weakSection = examCtx?.hasWeaknessData && examCtx.weakTopics.length > 0
    ? `نقاط الضعف المرصودة (مرتبة من الأضعف إلى الأقوى):\n${examCtx.weakTopics.slice(0, 6).map((t, i) => `  ${i + 1}. ${t}`).join('\n')}`
    : 'لا توجد بيانات امتحانات سابقة للطالب — سيتم اختيار أسئلة متنوعة.';

  const examSection = examCtx?.formattedContext ?? 'لا توجد أسئلة في بنك الامتحانات لهذه المادة حالياً.';

  const ragSection = ragContext
    ? `== مقاطع الكتاب المدرسي (للاستخدام في الشرح فقط) ==\n${ragContext}`
    : 'لا توجد مقاطع منهجية متاحة حالياً.';

  return `أنت Sage — مدرس خصوصي ذكي في وضع "تدريب الامتحانات".

==================================================
النطاق المحدد
==================================================
- الدولة: ${countryLabel}
- المرحلة: ${levelLabel}
- المادة: ${curriculum.subject ?? 'غير محدد'}

==================================================
${weakSection}
==================================================

${examSection}

==================================================
${ragSection}
==================================================

==================================================
دورك كمدرس خصوصي — قواعد لا تتجاوزها
==================================================
1. عندما يطلب الطالب التدريب أو المراجعة أو الامتحان:
   → اطرح سؤالاً واحداً فقط من قائمة الأسئلة أعلاه.
   → ابدأ دائماً بمواضيع الضعف المرصودة.
   → لا تكشف الإجابة الصحيحة قبل أن يجيب الطالب.

2. عندما يجيب الطالب على سؤال:
   → قيّم إجابته فوراً (صحيحة / خاطئة / جزئية).
   → إذا أصاب: امدحه بإيجاز وانتقل للسؤال التالي.
   → إذا أخطأ: اشرح الإجابة الصحيحة مستخدماً مقاطع الكتاب المدرسي أعلاه.

3. إذا سأل الطالب سؤالاً نظرياً أو مفاهيمياً:
   → أجب فقط من مقاطع الكتاب المدرسي أعلاه.
   → لا تستخدم معرفة خارجية أو ذاكرة النموذج.

4. ركّز دائماً على المواضيع الضعيفة قبل القوية.
5. إذا نفدت أسئلة الضعف، انتقل للأسئلة الأخرى.
6. لا تخرج عن نطاق المادة والمرحلة المحددتين.
7. أجب بالعربية الفصحى الواضحة. استخدم markdown وLaTeX للمعادلات.`;
}

// ─── NOTES_MODE: Explicit RAG Handler ────────────────────────────────────────

/**
 * Handles NOTES_MODE requests.
 *
 * Notes storage is not yet implemented on the backend — there is no dedicated
 * notes index to search. Until that backend exists, NOTES_MODE uses the same
 * curriculum RAG pipeline as BOOK_MODE.
 *
 * This function exists to make the routing EXPLICIT. NOTES_MODE must never
 * silently fall through to BOOK_MODE's dispatch branch — that would mean any
 * future NOTES_MODE behaviour change requires editing the core dispatch, which
 * violates the "one handler per mode" contract.
 *
 * When the notes backend is ready:
 *   1. Add a `searchNotes()` call here (analogous to `retrieveContext()`).
 *   2. Merge notes results with curriculum RAG results.
 *   3. Build a notes-aware system prompt (analogous to `buildStrictRAGPrompt()`).
 *   No other file needs to change.
 */
async function answerWithNotesMode(req: AnswerRequest): Promise<AnswerResult> {
  // Guard — no subject selected
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

  // Step 1 — RAG retrieval (curriculum source; notes source not yet implemented)
  const [modelId, ragResult] = await Promise.all([
    resolveModel(),
    retrieveContext(req.curriculum, req.message),
  ]);

  // Hard gate — no curriculum content available
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

  // Step 2 — Build system prompt (reuses strict RAG prompt; notes layer TBD)
  const systemPrompt = buildStrictRAGPrompt(req.curriculum, ragResult.formatted, req.studentContext);

  // Step 3 — Call Gemini via backend proxy
  const text = await callGemini(
    modelId,
    systemPrompt,
    req.history,
    req.message,
    'NOTES_MODE'
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

// ─── EXAM_MODE: Socratic Tutor Handler ───────────────────────────────────────

/**
 * Handles EXAM_MODE requests using the Socratic Tutor approach:
 *   1. Fetches weakness-targeted exam questions in parallel with RAG retrieval
 *   2. Builds a tutor system prompt that blends both contexts
 *   3. Gemini acts as a one-question-at-a-time tutor, not a search engine
 *
 * Unlike BOOK_MODE, does NOT gate on RAG returning chunks — exam questions
 * can still be used for tutoring even without curriculum context.
 */
async function answerWithExamMode(req: AnswerRequest): Promise<AnswerResult> {
  // Guard — no subject selected
  if (!req.curriculum.subject) {
    return {
      text: 'يرجى اختيار المادة أولاً لكي أتمكن من تدريبك بأسئلة بنك الامتحانات.',
      ragChunksFound: 0,
      retrievedContext: null,
      modelUsed: '',
      noSubject: true,
      noContext: false,
    };
  }

  const [modelId, examCtx, ragResult] = await Promise.all([
    resolveModel(),
    fetchExamContext(req.curriculum),
    retrieveContext(req.curriculum, req.message),
  ]);

  // Guard — exam bank is completely empty for this subject
  // Do NOT silently fall back to QUIZ_MODE behavior (that hides the distinction).
  if (examCtx !== null && examCtx.totalInBank === 0) {
    const subjectLabel = req.curriculum.subject ?? 'هذه المادة';
    return {
      text: `لا توجد امتحانات مرفوعة لمادة **${subjectLabel}** في بنك الامتحانات حتى الآن.\n\nيمكنك:\n- اختيار مادة **الأحياء** أو **الكيمياء** التي يوجد فيها امتحانات مرفوعة.\n- أو استخدام **الاختبار التفاعلي** الذي يولّد أسئلة من الكتاب المدرسي مباشرةً.`,
      ragChunksFound: 0,
      retrievedContext: null,
      modelUsed: '',
      noSubject: false,
      noContext: true,
    };
  }

  // EXAM_MODE system prompt is self-contained: buildExamTutorPrompt() already
  // embeds the full weakness profile sourced from the exam bank backend (the
  // authoritative weakness source for this mode). Injecting studentContext on
  // top would duplicate weak-topic data from two different sources and could
  // produce contradictory prioritisation. Student context is intentionally
  // excluded here — it is appropriate only for BOOK_MODE and QUIZ_MODE.
  const systemPrompt = buildExamTutorPrompt(
    req.curriculum,
    examCtx,
    ragResult?.formatted ?? null
  );

  const text = await callGemini(
    modelId,
    systemPrompt,
    req.history,
    req.message,
    'EXAM_MODE'
  );

  return {
    text,
    ragChunksFound: ragResult?.chunks ?? 0,
    retrievedContext: examCtx?.formattedContext ?? ragResult?.formatted ?? null,
    modelUsed: modelId,
    noSubject: false,
    noContext: false,
  };
}

// ─── QUIZ_MODE: Quiz Master Handler ──────────────────────────────────────────

/**
 * Handles QUIZ_MODE requests using a quiz-master approach:
 *   1. Retrieves curriculum RAG context (REQUIRED — no quiz without source material)
 *   2. Builds a quiz-master system prompt via quizEngine.buildQuizPrompt()
 *   3. Gemini generates one question per turn, evaluates answers, explains mistakes
 *
 * Hard gate: if RAG returns no chunks → returns NO_QUIZ_CONTENT_RESPONSE.
 * Gemini is NOT called in that case (same gate as BOOK_MODE).
 *
 * Differs from EXAM_MODE:
 *   - Questions come from curriculum RAG (generated on-the-fly), not the exam bank.
 *   - No weakness targeting (student uses it for immediate self-testing).
 */
async function answerWithQuizMode(req: AnswerRequest): Promise<AnswerResult> {
  const [modelId, ragResult] = await Promise.all([
    resolveModel(),
    retrieveContext(req.curriculum, req.message),
  ]);

  // Hard gate: quiz requires curriculum content to generate questions from
  if (!ragResult) {
    return {
      text: NO_QUIZ_CONTENT_RESPONSE,
      ragChunksFound: 0,
      retrievedContext: null,
      modelUsed: 'none',
      noSubject: false,
      noContext: true,
    };
  }

  // Phase 3: append student context to quiz prompt so the quiz master
  // can prioritise weak topics when generating questions.
  const baseQuizPrompt = buildQuizPrompt({
    country:    req.curriculum.country,
    level:      req.curriculum.level,
    subject:    req.curriculum.subject ?? '',
    track:      req.curriculum.track,
    ragContext: ragResult.formatted,
  });
  const systemPrompt = req.studentContext
    ? baseQuizPrompt + (formatStudentContextSection(req.studentContext) ?? '')
    : baseQuizPrompt;

  const text = await callGemini(
    modelId,
    systemPrompt,
    req.history,
    req.message,
    'QUIZ_MODE'
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

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Answer a student question. Dispatches to the correct handler based on mode.
 *
 * Mode → Handler mapping (every registered mode has an explicit branch):
 *   EXAM_MODE   → answerWithExamMode()  — Socratic Tutor, exam bank + RAG
 *   QUIZ_MODE   → answerWithQuizMode()  — Quiz Master, curriculum RAG questions
 *   NOTES_MODE  → answerWithNotesMode() — Notes RAG (notes backend TBD)
 *   BOOK_MODE   → inline strict RAG path
 *
 * No mode falls through to another mode's logic. Adding a future mode requires
 * only: (1) register in contextMode.ts, (2) create a handler, (3) add a branch here.
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

  // ── Mode dispatch ──────────────────────────────────────────────────────────
  const activeMode = req.mode ?? DEFAULT_MODE;
  buildContextObject(activeMode); // validates mode is registered

  if (activeMode === 'EXAM_MODE') {
    return answerWithExamMode(req);
  }

  if (activeMode === 'QUIZ_MODE') {
    return answerWithQuizMode(req);
  }

  if (activeMode === 'NOTES_MODE') {
    return answerWithNotesMode(req);
  }
  // ──────────────────────────────────────────────────────────────────────────

  // ── BOOK_MODE: Strict RAG path ────────────────────────────────────────────
  // Only BOOK_MODE reaches this point. Every other registered mode has its own
  // explicit dispatch branch above. This prevents any future mode from silently
  // inheriting BOOK_MODE behaviour.

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

  // Step 2 — Build strict RAG-only system prompt (Phase 3: with optional student context)
  const systemPrompt = buildStrictRAGPrompt(req.curriculum, ragResult.formatted, req.studentContext);

  // Step 3 — Call Gemini via backend proxy with retrieved context only
  const text = await callGemini(
    modelId,
    systemPrompt,
    req.history,
    req.message,
    activeMode
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
