/**
 * AI ORCHESTRATOR — Connection Phase
 *
 * This is the ONLY layer allowed to coordinate engines.
 * It controls execution order, ensures no overlap, manages async operations,
 * and enforces the RAG-only answering rule.
 *
 * Execution Order (strictly enforced):
 *   1. Answer Engine  → must complete before anything else uses its output
 *   2. Flashcard Gen  → async, non-blocking, fires after answer is returned
 *   3. Weakness Engine → sync, computed from existing cards at request time
 *
 * UI receives the answer immediately. Card generation and weakness updates
 * are delivered via callbacks so the UI never waits for them.
 */

import { answerQuestion } from './answerEngine';
import type { AnswerRequest, AnswerResult } from './answerEngine';
import { type ContextMode, DEFAULT_MODE } from './contextMode';

import { generateCards, evaluateAnswer } from './flashcardGenEngine';
import type { CardGenRequest, CardGenResult, EvalRequest } from './flashcardGenEngine';

import { analyzeWeakness, getTopWeakTopics, summarizeWeakness } from './weaknessEngine';
import type { WeaknessProfile, UnderstandingRecord } from './weaknessEngine';

import type { Flashcard } from '../../store/useAppStore';
import type { UnderstandingCheck, EvaluationResult } from '../flashcardEngine';

// ─── Public Types ─────────────────────────────────────────────────────────────

export interface OrchestratorRequest {
  /** Student's message */
  message: string;
  /** Conversation history for the Answer Engine */
  history: AnswerRequest['history'];
  /** Active curriculum context */
  curriculum: AnswerRequest['curriculum'];
  /** Current flashcard collection (for dedup + daily limit + weakness) */
  existingCards: Flashcard[];
  /** Student profile for card tagging */
  studentProfile: CardGenRequest['studentProfile'];
  /** Past comprehension check results (for weakness scoring) */
  checkHistory?: UnderstandingRecord[];
  /**
   * Active Context Mode — controls which resources Sage consults.
   * Defaults to BOOK_MODE when not provided (backward compatible).
   */
  mode?: ContextMode;
}

export interface OrchestratorResult {
  /** The answer text — delivered synchronously */
  answer: AnswerResult;
  /** Current weakness snapshot (computed synchronously before answer) */
  weakness: WeaknessProfile;
  /** How many RAG chunks grounded the answer */
  ragChunksFound: number;
}

export type CardGenCallback = (result: CardGenResult) => void;

export interface OrchestrateOptions {
  /**
   * Called asynchronously after card generation completes.
   * The UI should use this to push new cards into the store.
   */
  onCardsGenerated?: CardGenCallback;
  /**
   * If false, flashcard generation is skipped entirely.
   * Default: true
   */
  generateFlashcards?: boolean;
}

// ─── Error Codes ──────────────────────────────────────────────────────────────

export type OrchestratorErrorCode =
  | 'NO_API_KEY'
  | 'QUOTA_EXCEEDED'
  | 'ANSWER_FAILED'
  | 'NETWORK_ERROR';

export class OrchestratorError extends Error {
  constructor(
    public readonly code: OrchestratorErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'OrchestratorError';
  }
}

// ─── Internal Helpers ─────────────────────────────────────────────────────────

function mapAnswerError(err: unknown): OrchestratorError {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg === 'NO_API_KEY' || msg.includes('not configured')) {
    return new OrchestratorError('NO_API_KEY', 'مفتاح API غير متوفر.');
  }
  if (msg === 'QUOTA_EXCEEDED' || msg.toLowerCase().includes('quota')) {
    return new OrchestratorError('QUOTA_EXCEEDED', 'تم استنفاد حصة API. حاول لاحقاً.');
  }
  return new OrchestratorError('ANSWER_FAILED', msg);
}

/**
 * Fire-and-forget card generation.
 * Never blocks the caller. All errors are swallowed and logged.
 */
function launchCardGeneration(
  answerText: string,
  req: OrchestratorRequest,
  onCardsGenerated?: CardGenCallback
): void {
  const cardReq: CardGenRequest = {
    aiResponse: answerText,
    curriculum: req.curriculum,
    existingCards: req.existingCards,
    studentProfile: req.studentProfile,
  };

  generateCards(cardReq)
    .then((result) => {
      if (result.cards.length > 0 || result.understandingCheck) {
        onCardsGenerated?.(result);
      }
    })
    .catch((err) => {
      console.warn('[Orchestrator] Card generation failed (non-critical):', err);
    });
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Main entry point for the AI tutoring system.
 *
 * Execution:
 *   1. Compute weakness profile (sync, instant)
 *   2. Run Answer Engine (async, awaited — caller blocks until answer is ready)
 *   3. Launch card generation (async, fire-and-forget via callback)
 *
 * @throws OrchestratorError if the answer cannot be generated
 */
export async function orchestrate(
  req: OrchestratorRequest,
  options: OrchestrateOptions = {}
): Promise<OrchestratorResult> {
  const { onCardsGenerated, generateFlashcards = true } = options;

  // Step 1 — Weakness snapshot (sync, instant, no await needed)
  const weakness = analyzeWeakness(req.existingCards, req.checkHistory ?? []);

  // Step 2 — Answer Engine (strict RAG, must complete first)
  let answer: AnswerResult;
  try {
    answer = await answerQuestion({
      message: req.message,
      history: req.history,
      curriculum: req.curriculum,
      mode: req.mode ?? DEFAULT_MODE,
    });
  } catch (err) {
    throw mapAnswerError(err);
  }

  // Step 3 — Card generation (non-blocking, fire-and-forget)
  if (generateFlashcards) {
    launchCardGeneration(answer.text, req, onCardsGenerated);
  }

  return {
    answer,
    weakness,
    ragChunksFound: answer.ragChunksFound,
  };
}

/**
 * Evaluate a student's comprehension check answer.
 * Delegates directly to the Flashcard Gen Engine (evaluation responsibility).
 * The orchestrator routes this call; it does not implement evaluation logic.
 */
export async function evaluateComprehension(
  req: EvalRequest,
  existingCards: Flashcard[],
  checkHistory: UnderstandingRecord[],
  onMistakeCard?: (card: { question: string; answer: string; category: string }) => void
): Promise<EvaluationResult & { updatedWeakness: WeaknessProfile }> {
  const result = await evaluateAnswer(req);

  if (result.mistakeCard) {
    onMistakeCard?.(result.mistakeCard);
  }

  // Recompute weakness after potential new mistake card
  const projectedCards: Flashcard[] = result.mistakeCard
    ? [
        ...existingCards,
        {
          id: '__tmp__',
          front: result.mistakeCard.question,
          back: result.mistakeCard.answer,
          category: result.mistakeCard.category,
          source: 'student_mistake',
          status: 'new',
          createdAt: Date.now(),
          reviewCount: 0,
        } as Flashcard,
      ]
    : existingCards;

  const updatedRecord: UnderstandingRecord = {
    topic: req.category,
    understood: result.understood,
    timestamp: Date.now(),
  };

  const updatedWeakness = analyzeWeakness(projectedCards, [
    ...checkHistory,
    updatedRecord,
  ]);

  return { ...result, updatedWeakness };
}

/**
 * Get a plain-language weakness summary for display in the UI.
 * Pure pass-through to the Weakness Engine's summarize utility.
 */
export function getWeaknessSummary(profile: WeaknessProfile): string {
  return summarizeWeakness(profile);
}

/**
 * Get the top N weakest topics for targeted study recommendations.
 */
export function getWeakTopics(
  profile: WeaknessProfile,
  n = 3
): ReturnType<typeof getTopWeakTopics> {
  return getTopWeakTopics(profile, n);
}

// Re-export types that UI layers need from one import point
export type { WeaknessProfile, UnderstandingRecord, UnderstandingCheck, EvaluationResult };
