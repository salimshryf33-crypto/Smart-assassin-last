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

// ─── Internal Helpers ─────────────────────────────────────────────────────────

async function callGeminiJSON<T>(prompt: string): Promise<T | null> {
  try {
    const model = await resolveModel();
    const res = await fetch('/api/gemini/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 1024, temperature: 0.4 },
      }),
    });
    if (!res.ok) {
      console.error('[FlashcardGenEngine] Gemini returned', res.status, 'for model:', model);
      return null;
    }
    const data = await res.json();
    const text: string = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]) as T;
  } catch (err) {
    console.error('[FlashcardGenEngine] callGeminiJSON error:', err);
    return null;
  }
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

  return `You are a flashcard extraction engine for a student learning app.

Given the AI tutor's response below, do TWO things:
1. Extract 0-${Math.min(maxCards, 5)} key learning flashcards
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

  interface RawResponse {
    flashcards: Array<{ question: string; answer: string; category: string }>;
    understandingCheck: { question: string; correctAnswer: string } | null;
  }

  const raw = await callGeminiJSON<RawResponse>(prompt);
  if (!raw || !Array.isArray(raw.flashcards)) return empty;

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
