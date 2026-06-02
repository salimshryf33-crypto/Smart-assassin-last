/**
 * FLASHCARD GENERATION ENGINE — Async Learning
 *
 * Responsibility:
 *   Given a completed AI tutor response, extract key learning flashcards and
 *   optionally generate a comprehension-check question. Enforces daily limits,
 *   deduplication, and SM-2 initialization.
 *
 * Rules:
 *   - NEVER answers student questions
 *   - NEVER performs weakness analysis
 *   - NEVER calls other engines
 *   - Returns empty result gracefully when no key is available
 *   - All generation is ASYNC (Gemini extraction prompt)
 */

import type { Flashcard } from '../../store/useAppStore';
import type { CurriculumContext } from '../../utils/ai';
import {
  isDuplicate,
  getAIGeneratedTodayCount,
  MAX_FLASHCARDS_PER_DAY,
  type UnderstandingCheck,
  type EvaluationResult,
} from '../flashcardEngine';
import { resolveModel } from './modelResolver';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CardGenRequest {
  /** The full AI tutor response text to extract cards from */
  aiResponse: string;
  curriculum: CurriculumContext;
  existingCards: Flashcard[];
  studentProfile: {
    country: string;
    level: string;
    track: string;
  };
}

export interface CardGenResult {
  cards: Omit<Flashcard, 'id' | 'createdAt' | 'reviewCount'>[];
  understandingCheck: UnderstandingCheck | null;
  skippedDuplicate: number;
  cappedByLimit: boolean;
  dailyTotal: number;
}

export interface EvalRequest {
  check: UnderstandingCheck;
  studentAnswer: string;
  category: string;
}

// ─── Raw card shape returned by Gemini ───────────────────────────────────────

interface RawCard {
  question: string;
  answer: string;
  category: string;
}

interface RawResponse {
  flashcards: RawCard[];
  understandingCheck: { question: string; correctAnswer: string } | null;
}

// ─── Resilient JSON parser ────────────────────────────────────────────────────
//
// Two-pass approach:
//   Pass 1 — try standard JSON.parse on the full cleaned response.
//   Pass 2 — if the JSON was truncated (no closing brace, parse throws),
//             scan for individually-complete card objects using a character-
//             level regex and salvage whichever cards finished before the cut.
//             This is the main defence against maxOutputTokens truncation.
//
// ─────────────────────────────────────────────────────────────────────────────

// Matches a single complete flashcard object: all three string fields present.
// Handles Arabic text, escaped quotes, and any Unicode.
const CARD_OBJECT_RE =
  /\{\s*"question"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"answer"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"category"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/g;

function parseFlashcardJSON(raw: string): RawResponse | null {
  const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

  // Pass 1: standard parse
  const jsonMatch = cleaned.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as RawResponse;
      if (Array.isArray(parsed.flashcards)) return parsed;
    } catch {
      // fall through to salvage pass
    }
  }

  // Pass 2: salvage complete card objects from a truncated response
  CARD_OBJECT_RE.lastIndex = 0;
  const salvaged: RawCard[] = [];
  let m: RegExpExecArray | null;
  while ((m = CARD_OBJECT_RE.exec(cleaned)) !== null) {
    try {
      const card = JSON.parse(m[0]) as RawCard;
      if (card.question?.trim() && card.answer?.trim()) {
        salvaged.push(card);
      }
    } catch {
      // skip malformed match
    }
  }

  if (salvaged.length > 0) {
    console.warn(
      '[FlashcardGenEngine] Salvaged',
      salvaged.length,
      'card(s) from truncated JSON (understandingCheck discarded)'
    );
    return { flashcards: salvaged, understandingCheck: null };
  }

  console.error('[FlashcardGenEngine] JSON parse failed. Raw text snippet:', raw.slice(0, 200));
  return null;
}

// ─── Gemini call with retry ───────────────────────────────────────────────────

async function callGeminiJSON<T>(prompt: string): Promise<T | null> {
  const model = await resolveModel();

  const attempt = async (): Promise<{ status: number; text: string } | null> => {
    try {
      const res = await fetch('/api/gemini/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          // 2048 tokens — enough for 3 Arabic cards (~150 tokens each) +
          // comprehension check + JSON structure overhead, without truncation.
          generationConfig: { maxOutputTokens: 2048, temperature: 0.4 },
        }),
      });
      if (!res.ok) {
        return { status: res.status, text: '' };
      }
      const data = await res.json();
      const text: string = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      return { status: 200, text };
    } catch (err) {
      console.error('[FlashcardGenEngine] fetch error:', err);
      return null;
    }
  };

  let result = await attempt();

  // Retry once on 503 (Gemini transient overload) after 2s
  if (result && result.status === 503) {
    console.warn('[FlashcardGenEngine] 503 — retrying in 2s (model:', model, ')');
    await new Promise((r) => setTimeout(r, 2000));
    result = await attempt();
  }

  if (!result) return null;

  if (result.status !== 200) {
    console.error('[FlashcardGenEngine] Gemini returned', result.status, 'for model:', model);
    return null;
  }

  const { text } = result;
  if (!text) {
    console.error(
      '[FlashcardGenEngine] Gemini returned 200 but empty text (safety block or empty candidates). model:',
      model
    );
    return null;
  }

  return parseFlashcardJSON(text) as unknown as T;
}

// ─── Extraction Prompt ────────────────────────────────────────────────────────

function buildExtractionPrompt(
  aiResponse: string,
  curriculum: CurriculumContext,
  studentProfile: CardGenRequest['studentProfile'],
  maxCards: number
): string {
  const ctx = JSON.stringify({
    country: studentProfile.country,
    level: studentProfile.level,
    track: studentProfile.track,
    subject: curriculum.subject ?? '',
  });

  // Cap at 3 cards per call — keeps the response well within 2048 tokens for
  // Arabic answers and guarantees complete JSON even with long per-card text.
  const cardLimit = Math.min(maxCards, 3);

  return `You are a flashcard extraction engine for a student learning app.

Given the AI tutor's response below, do TWO things:
1. Extract 0-${cardLimit} key learning flashcards
2. Optionally generate ONE understanding check question

RULES FOR FLASHCARDS:
- Only extract cards for: key concepts, definitions, formulas, exam-relevant facts, corrected misconceptions
- Do NOT create cards for: greetings, casual conversation, scheduling, general study advice, yes/no answers
- Each card needs: question (front), answer (back), category (subject area e.g. "Biology", "Physics")
- Keep questions concise and specific (max 15 words)
- Keep answers short (1-3 sentences, max 40 words)
- Questions and answers should be in the SAME language as the AI response

RULES FOR UNDERSTANDING CHECK:
- Generate ONLY if the response explains an important academic concept, formula, or definition
- The question must test comprehension, not just recall
- Return null if the response is casual, a greeting, or general advice

CURRICULUM CONTEXT: ${ctx}

AI TUTOR'S RESPONSE:
${aiResponse.slice(0, 1500)}

Return ONLY valid JSON (no markdown, no explanation):
{
  "flashcards": [
    {"question": "...", "answer": "...", "category": "..."}
  ],
  "understandingCheck": {"question": "...", "correctAnswer": "..."}
}

If no flashcards or no check, use empty array or null respectively.`;
}

// ─── Evaluation Prompt ────────────────────────────────────────────────────────

function buildEvaluationPrompt(
  check: UnderstandingCheck,
  studentAnswer: string
): string {
  return `You are evaluating a student's answer to a comprehension question.

Context (what was explained):
${check.context.slice(0, 400)}

Question: ${check.question}
Expected correct answer: ${check.correctAnswer}
Student's answer: ${studentAnswer}

Evaluate whether the student demonstrated understanding of the KEY concept.
Be lenient with wording — focus on conceptual correctness, not exact phrasing.

Return ONLY valid JSON:
{
  "understood": true or false,
  "feedback": "brief feedback in 1-2 sentences in the same language as the student's answer",
  "mistakeCard": {"question": "...", "answer": "..."}
}

Rules:
- Set understood = true if the student got the core concept right (even if imperfect)
- Set understood = false only for clearly wrong or missing key information
- feedback should be encouraging and specific
- Include mistakeCard ONLY if understood = false, targeting exactly what they got wrong
- mistakeCard question should be the corrected version of the check question
- If understood = true, mistakeCard must be null`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Extract flashcards from an AI tutor response.
 * Returns a safe empty result if server is unavailable or response is too short.
 */
export async function generateCards(req: CardGenRequest): Promise<CardGenResult> {
  const empty: CardGenResult = {
    cards: [],
    understandingCheck: null,
    skippedDuplicate: 0,
    cappedByLimit: false,
    dailyTotal: getAIGeneratedTodayCount(req.existingCards),
  };

  if (!req.aiResponse || req.aiResponse.length < 80) return empty;

  const todayCount = getAIGeneratedTodayCount(req.existingCards);
  if (todayCount >= MAX_FLASHCARDS_PER_DAY) {
    return { ...empty, cappedByLimit: true, dailyTotal: todayCount };
  }

  const remaining = MAX_FLASHCARDS_PER_DAY - todayCount;
  const prompt = buildExtractionPrompt(
    req.aiResponse,
    req.curriculum,
    req.studentProfile,
    remaining
  );

  const raw = await callGeminiJSON<RawResponse>(prompt);
  if (!raw || !Array.isArray(raw.flashcards)) {
    console.log('[FlashcardGenEngine] generated=0 saved=0 skipped=0 (null/invalid raw — see errors above)');
    return empty;
  }

  let skippedDuplicate = 0;
  const accepted: Omit<Flashcard, 'id' | 'createdAt' | 'reviewCount'>[] = [];
  const pool = [...req.existingCards];

  for (const item of raw.flashcards) {
    if (!item.question?.trim() || !item.answer?.trim()) continue;
    if (isDuplicate(item.question, pool)) {
      skippedDuplicate++;
      continue;
    }

    const card: Omit<Flashcard, 'id' | 'createdAt' | 'reviewCount'> = {
      front: item.question.trim(),
      back: item.answer.trim(),
      category: item.category?.trim() || req.curriculum.subject || 'General',
      source: 'ai_explanation',
      status: 'new',
      easeFactor: 2.5,
      interval: 1,
      repetitions: 0,
      nextReviewDate: Date.now(),
      curriculumTag: {
        country: req.studentProfile.country,
        level: req.studentProfile.level,
        track: req.studentProfile.track,
        subject: req.curriculum.subject ?? '',
      },
    };

    accepted.push(card);
    pool.push({ ...card, id: 'tmp', createdAt: Date.now(), reviewCount: 0 });

    if (accepted.length + todayCount >= MAX_FLASHCARDS_PER_DAY) break;
  }

  const understandingCheck: UnderstandingCheck | null =
    raw.understandingCheck?.question
      ? { ...raw.understandingCheck, context: req.aiResponse.slice(0, 500) }
      : null;

  // Note: saved= is logged in AIChat.tsx after Firestore writes complete.
  // generated= here reflects cards accepted by the engine before save.
  console.log(
    `[FlashcardGenEngine] generated=${accepted.length} skipped=${skippedDuplicate} check=${!!understandingCheck}`
  );

  return {
    cards: accepted,
    understandingCheck,
    skippedDuplicate,
    cappedByLimit: false,
    dailyTotal: todayCount + accepted.length,
  };
}

/**
 * Evaluate a student's comprehension-check answer.
 * Returns a safe "pass" result if server is unavailable.
 */
export async function evaluateAnswer(req: EvalRequest): Promise<EvaluationResult> {
  if (!req.studentAnswer.trim() || req.studentAnswer.trim().length < 3) {
    return {
      understood: false,
      feedback: 'الإجابة قصيرة جداً. حاول الإجابة بجملة كاملة.',
      mistakeCard: null,
    };
  }

  const prompt = buildEvaluationPrompt(req.check, req.studentAnswer);
  const result = await callGeminiJSON<{
    understood: boolean;
    feedback: string;
    mistakeCard: { question: string; answer: string } | null;
  }>(prompt);

  if (!result) {
    return { understood: true, feedback: 'تعذر التقييم. استمر في المراجعة!', mistakeCard: null };
  }

  return {
    understood: result.understood ?? true,
    feedback: result.feedback ?? '',
    mistakeCard: result.mistakeCard ? { ...result.mistakeCard, category: req.category } : null,
  };
}
