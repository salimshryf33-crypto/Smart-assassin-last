import type { Flashcard } from '../store/useAppStore';
import type { CurriculumContext } from '../utils/ai';

// ─── Constants ────────────────────────────────────────────────────────────────

export const MAX_FLASHCARDS_PER_DAY = 10;
const DUPLICATE_THRESHOLD = 0.70;

// ─── Extended Flashcard Fields (all optional for backward compat) ─────────────

export type FlashcardSource = 'manual' | 'ai_explanation' | 'student_mistake' | 'exam_question';
export type FlashcardStatus = 'new' | 'learning' | 'review' | 'mastered';

export interface FlashcardCurriculumTag {
  country: string;
  level: string;
  track: string;
  subject: string;
  lesson?: string;
}

// ─── Understanding Check ──────────────────────────────────────────────────────

export interface UnderstandingCheck {
  question: string;
  correctAnswer: string;
  context: string;
}

export interface EvaluationResult {
  understood: boolean;
  feedback: string;
  mistakeCard: { question: string; answer: string; category: string } | null;
}

// ─── Generation Result ────────────────────────────────────────────────────────

export interface GenerationResult {
  cards: Omit<Flashcard, 'id' | 'createdAt' | 'reviewCount'>[];
  understandingCheck: UnderstandingCheck | null;
  skippedDuplicate: number;
  cappedByLimit: boolean;
}

// ─── SM-2 Spaced Repetition ───────────────────────────────────────────────────

export function updateCardSRS(card: Flashcard, quality: number): Partial<Flashcard> {
  const reps = card.repetitions ?? 0;
  const ef = card.easeFactor ?? 2.5;
  const interval = card.interval ?? 1;

  const newEF = Math.max(1.3, ef + 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));

  let newInterval: number;
  let newReps: number;

  if (quality < 3) {
    newInterval = 1;
    newReps = 0;
  } else {
    newReps = reps + 1;
    if (reps === 0) newInterval = 1;
    else if (reps === 1) newInterval = 6;
    else newInterval = Math.round(interval * newEF);
  }

  const newStatus: FlashcardStatus =
    quality < 3
      ? 'learning'
      : newReps >= 5 && newEF >= 2.5
        ? 'mastered'
        : newReps >= 2
          ? 'review'
          : 'learning';

  return {
    easeFactor: newEF,
    interval: newInterval,
    repetitions: newReps,
    status: newStatus,
    nextReviewDate: Date.now() + newInterval * 24 * 60 * 60 * 1000,
    lastReviewed: Date.now(),
    reviewCount: (card.reviewCount ?? 0) + 1,
  };
}

// ─── Review Prioritization ────────────────────────────────────────────────────

export function prioritizeCards(cards: Flashcard[]): Flashcard[] {
  const now = Date.now();
  return [...cards].sort((a, b) => {
    const aWeak = a.source === 'student_mistake';
    const bWeak = b.source === 'student_mistake';
    if (aWeak && !bWeak) return -1;
    if (bWeak && !aWeak) return 1;

    const aDue = !a.nextReviewDate || a.nextReviewDate <= now;
    const bDue = !b.nextReviewDate || b.nextReviewDate <= now;
    if (aDue && !bDue) return -1;
    if (bDue && !aDue) return 1;

    const aNew = !a.lastReviewed;
    const bNew = !b.lastReviewed;
    if (aNew && !bNew) return -1;
    if (bNew && !aNew) return 1;

    return (a.nextReviewDate ?? 0) - (b.nextReviewDate ?? 0);
  });
}

// ─── Flashcard Stats ──────────────────────────────────────────────────────────

export interface FlashcardStats {
  totalCards: number;
  dueToday: number;
  masteredCards: number;
  weakConcepts: number;
  aiGeneratedCards: number;
}

export function computeFlashcardStats(cards: Flashcard[]): FlashcardStats {
  const now = Date.now();
  return {
    totalCards: cards.length,
    dueToday: cards.filter((c) => !c.nextReviewDate || c.nextReviewDate <= now).length,
    masteredCards: cards.filter((c) => c.status === 'mastered').length,
    weakConcepts: cards.filter((c) => c.source === 'student_mistake').length,
    aiGeneratedCards: cards.filter(
      (c) =>
        c.source === 'ai_explanation' ||
        c.source === 'student_mistake' ||
        c.source === 'exam_question'
    ).length,
  };
}

// ─── Duplicate Detection (Jaccard Similarity) ─────────────────────────────────

function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\w\s\u0600-\u06ff]/g, '')
    .trim();
}

function jaccardSimilarity(a: string, b: string): number {
  const words = (s: string) => new Set(normalizeText(s).split(/\s+/).filter(Boolean));
  const setA = words(a);
  const setB = words(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  const intersection = new Set([...setA].filter((x) => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

export function isDuplicate(question: string, existingCards: Flashcard[]): boolean {
  return existingCards.some((c) => jaccardSimilarity(question, c.front) >= DUPLICATE_THRESHOLD);
}

// ─── Daily Limit ──────────────────────────────────────────────────────────────

export function getAIGeneratedTodayCount(cards: Flashcard[]): number {
  const today = new Date().toDateString();
  return cards.filter(
    (c) =>
      (c.source === 'ai_explanation' ||
        c.source === 'student_mistake' ||
        c.source === 'exam_question') &&
      new Date(c.createdAt).toDateString() === today
  ).length;
}

// ─── Gemini JSON Call (shared utility) ───────────────────────────────────────

function getApiKey(): string | null {
  return import.meta.env.VITE_GEMINI_API_KEY || localStorage.getItem('sage_gemini_api_key') || null;
}

async function callGeminiJSON<T>(prompt: string): Promise<T | null> {
  const apiKey = getApiKey();
  if (!apiKey) return null;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${apiKey}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 1024, temperature: 0.4 },
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text: string = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]) as T;
  } catch (err) {
    console.error('[FlashcardEngine] callGeminiJSON error:', err);
    return null;
  }
}

// ─── Flashcard Generation from AI Response ────────────────────────────────────

interface RawGenerationResponse {
  flashcards: Array<{ question: string; answer: string; category: string }>;
  understandingCheck: { question: string; correctAnswer: string } | null;
}

export async function generateFlashcardsFromAIResponse(
  aiResponse: string,
  curriculum: CurriculumContext,
  existingCards: Flashcard[],
  studentProfile: { country: string; level: string; track: string }
): Promise<GenerationResult> {
  if (!aiResponse || aiResponse.length < 80) {
    return { cards: [], understandingCheck: null, skippedDuplicate: 0, cappedByLimit: false };
  }

  const todayCount = getAIGeneratedTodayCount(existingCards);
  if (todayCount >= MAX_FLASHCARDS_PER_DAY) {
    console.log('[FlashcardEngine] Daily limit reached:', todayCount);
    return { cards: [], understandingCheck: null, skippedDuplicate: 0, cappedByLimit: true };
  }

  const remaining = MAX_FLASHCARDS_PER_DAY - todayCount;
  const contextStr = JSON.stringify({
    country: studentProfile.country,
    level: studentProfile.level,
    track: studentProfile.track,
    subject: curriculum.subject ?? '',
  });

  const prompt = `You are a flashcard extraction engine for a student learning app.

Given the AI tutor's response below, do TWO things:
1. Extract 0-${Math.min(remaining, 5)} key learning flashcards  
2. Optionally generate ONE understanding check question

RULES FOR FLASHCARDS:
- Only extract cards for: key concepts, definitions, formulas, exam-relevant facts, corrected misconceptions
- Do NOT create cards for: greetings, casual conversation, scheduling, general study advice, questions answered with "yes/no"
- Each card needs: question (front), answer (back), category (subject area like "Biology", "Physics", etc.)
- Keep questions concise and specific (max 15 words)
- Keep answers short (1-3 sentences, max 40 words)
- Questions and answers should be in the SAME language as the AI response

RULES FOR UNDERSTANDING CHECK:
- Generate ONLY if the response explains an important academic concept, formula, or definition
- The question must test comprehension, not just recall  
- Return null if the response is casual, a greeting, or general advice

CURRICULUM CONTEXT: ${contextStr}

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

  const result = await callGeminiJSON<RawGenerationResponse>(prompt);
  if (!result || !Array.isArray(result.flashcards)) {
    return { cards: [], understandingCheck: null, skippedDuplicate: 0, cappedByLimit: false };
  }

  let skippedDuplicate = 0;
  const accepted: Omit<Flashcard, 'id' | 'createdAt' | 'reviewCount'>[] = [];

  const allCards = [...existingCards];

  for (const raw of result.flashcards) {
    if (!raw.question?.trim() || !raw.answer?.trim()) continue;
    if (isDuplicate(raw.question, allCards)) {
      skippedDuplicate++;
      continue;
    }

    const card: Omit<Flashcard, 'id' | 'createdAt' | 'reviewCount'> = {
      front: raw.question.trim(),
      back: raw.answer.trim(),
      category: raw.category?.trim() || curriculum.subject || 'General',
      source: 'ai_explanation',
      status: 'new',
      easeFactor: 2.5,
      interval: 1,
      repetitions: 0,
      nextReviewDate: Date.now(),
      curriculumTag: {
        country: studentProfile.country,
        level: studentProfile.level,
        track: studentProfile.track,
        subject: curriculum.subject ?? '',
      },
    };
    accepted.push(card);
    allCards.push({ ...card, id: 'tmp', createdAt: Date.now(), reviewCount: 0 });

    if (accepted.length + todayCount >= MAX_FLASHCARDS_PER_DAY) break;
  }

  const understandingCheck: UnderstandingCheck | null =
    result.understandingCheck?.question
      ? { ...result.understandingCheck, context: aiResponse.slice(0, 500) }
      : null;

  console.log(
    `[FlashcardEngine] Generated: ${accepted.length}, skipped: ${skippedDuplicate}, check: ${!!understandingCheck}`
  );

  return {
    cards: accepted,
    understandingCheck,
    skippedDuplicate,
    cappedByLimit: false,
  };
}

// ─── Understanding Answer Evaluation ─────────────────────────────────────────

export async function evaluateUnderstandingAnswer(
  check: UnderstandingCheck,
  studentAnswer: string,
  category: string
): Promise<EvaluationResult> {
  if (!studentAnswer.trim() || studentAnswer.trim().length < 3) {
    return {
      understood: false,
      feedback: 'الإجابة قصيرة جداً. حاول الإجابة بجملة كاملة.',
      mistakeCard: null,
    };
  }

  const prompt = `You are evaluating a student's answer to a comprehension question.

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

  const result = await callGeminiJSON<{
    understood: boolean;
    feedback: string;
    mistakeCard: { question: string; answer: string } | null;
  }>(prompt);

  if (!result) {
    return {
      understood: true,
      feedback: 'تعذر التقييم. استمر في المراجعة!',
      mistakeCard: null,
    };
  }

  return {
    understood: result.understood ?? true,
    feedback: result.feedback ?? '',
    mistakeCard: result.mistakeCard
      ? { ...result.mistakeCard, category }
      : null,
  };
}
