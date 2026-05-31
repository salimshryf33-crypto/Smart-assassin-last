/**
 * WEAKNESS DETECTION ENGINE — Analysis Only
 *
 * Responsibility:
 *   Analyze a student's flashcard performance history, mistake patterns, and
 *   comprehension check results to produce a weakness profile. Identifies
 *   which topics/concepts the student struggles with most.
 *
 * Rules:
 *   - PURE SYNCHRONOUS — no API calls, no async, no I/O
 *   - NEVER answers questions
 *   - NEVER generates flashcards
 *   - NEVER calls other engines
 *   - Input: raw data arrays. Output: plain data objects.
 */

import type { Flashcard } from '../../store/useAppStore';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WeakTopic {
  /** Flashcard category / subject area */
  topic: string;
  /** 0.0 (strongest) → 1.0 (weakest) */
  weaknessScore: number;
  /** Count of mistake-sourced or low-rating cards in this topic */
  mistakeCount: number;
  /** Count of total cards in this topic */
  totalCards: number;
  /** Average ease factor across topic cards (lower = weaker) */
  avgEaseFactor: number;
  /** How many cards in this topic are overdue for review */
  overdueCount: number;
}

export interface WeaknessProfile {
  /** Ordered by weaknessScore descending (weakest first) */
  weakTopics: WeakTopic[];
  /** Total cards analyzed */
  totalAnalyzed: number;
  /** Count of cards with source = 'student_mistake' */
  totalMistakeCards: number;
  /** Count of topics where weakness score > 0.6 (critical) */
  criticalTopicCount: number;
  /** ISO date string of analysis */
  analyzedAt: string;
  /** True if enough data exists to trust the profile (≥5 reviewed cards) */
  hasEnoughData: boolean;
}

export interface UnderstandingRecord {
  topic: string;
  understood: boolean;
  timestamp: number;
}

// ─── Scoring Constants ────────────────────────────────────────────────────────

const WEIGHT_MISTAKE_SOURCE = 0.40;   // card.source === 'student_mistake'
const WEIGHT_LOW_EASE = 0.25;         // easeFactor < 2.0
const WEIGHT_OVERDUE = 0.20;          // nextReviewDate in the past by > 3 days
const WEIGHT_FAILED_CHECK = 0.15;     // comprehension check failures

const CRITICAL_THRESHOLD = 0.6;
const MIN_DATA_CARDS = 5;

// ─── Internal Helpers ─────────────────────────────────────────────────────────

function groupByTopic(cards: Flashcard[]): Map<string, Flashcard[]> {
  const map = new Map<string, Flashcard[]>();
  for (const card of cards) {
    const topic = (card.category ?? 'General').trim();
    if (!map.has(topic)) map.set(topic, []);
    map.get(topic)!.push(card);
  }
  return map;
}

function countFailedChecks(topic: string, records: UnderstandingRecord[]): number {
  return records.filter((r) => r.topic === topic && !r.understood).length;
}

function totalChecksForTopic(topic: string, records: UnderstandingRecord[]): number {
  return records.filter((r) => r.topic === topic).length;
}

function computeWeaknessScore(
  cards: Flashcard[],
  failedChecks: number,
  totalChecks: number
): number {
  const now = Date.now();
  const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

  const reviewedCards = cards.filter((c) => c.lastReviewed);
  if (reviewedCards.length === 0 && cards.every((c) => c.source !== 'student_mistake')) {
    return 0;
  }

  const mistakeRatio =
    cards.length > 0
      ? cards.filter((c) => c.source === 'student_mistake').length / cards.length
      : 0;

  const lowEaseRatio =
    reviewedCards.length > 0
      ? reviewedCards.filter((c) => (c.easeFactor ?? 2.5) < 2.0).length / reviewedCards.length
      : 0;

  const overdueRatio =
    cards.length > 0
      ? cards.filter(
          (c) => c.nextReviewDate && now - c.nextReviewDate > THREE_DAYS_MS
        ).length / cards.length
      : 0;

  const failedCheckRatio = totalChecks > 0 ? failedChecks / totalChecks : 0;

  const score =
    mistakeRatio * WEIGHT_MISTAKE_SOURCE +
    lowEaseRatio * WEIGHT_LOW_EASE +
    overdueRatio * WEIGHT_OVERDUE +
    failedCheckRatio * WEIGHT_FAILED_CHECK;

  return Math.min(1.0, score);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Analyze flashcard and comprehension data to build a weakness profile.
 * Completely synchronous — safe to call anywhere without await.
 */
export function analyzeWeakness(
  cards: Flashcard[],
  checkHistory: UnderstandingRecord[] = []
): WeaknessProfile {
  const now = Date.now();
  const reviewedCards = cards.filter((c) => c.lastReviewed);
  const byTopic = groupByTopic(cards);

  const weakTopics: WeakTopic[] = [];

  for (const [topic, topicCards] of byTopic.entries()) {
    const failedChecks = countFailedChecks(topic, checkHistory);
    const totalChecks = totalChecksForTopic(topic, checkHistory);
    const weaknessScore = computeWeaknessScore(topicCards, failedChecks, totalChecks);

    const reviewedInTopic = topicCards.filter((c) => c.lastReviewed);
    const avgEaseFactor =
      reviewedInTopic.length > 0
        ? reviewedInTopic.reduce((sum, c) => sum + (c.easeFactor ?? 2.5), 0) /
          reviewedInTopic.length
        : 2.5;

    const overdueCount = topicCards.filter(
      (c) => c.nextReviewDate && c.nextReviewDate <= now
    ).length;

    weakTopics.push({
      topic,
      weaknessScore,
      mistakeCount: topicCards.filter((c) => c.source === 'student_mistake').length,
      totalCards: topicCards.length,
      avgEaseFactor,
      overdueCount,
    });
  }

  weakTopics.sort((a, b) => b.weaknessScore - a.weaknessScore);

  const criticalTopicCount = weakTopics.filter(
    (t) => t.weaknessScore >= CRITICAL_THRESHOLD
  ).length;

  return {
    weakTopics,
    totalAnalyzed: cards.length,
    totalMistakeCards: cards.filter((c) => c.source === 'student_mistake').length,
    criticalTopicCount,
    analyzedAt: new Date().toISOString(),
    hasEnoughData: reviewedCards.length >= MIN_DATA_CARDS,
  };
}

/**
 * Get the top N weakest topics from a profile.
 * Filters out topics with zero weakness score.
 */
export function getTopWeakTopics(profile: WeaknessProfile, n = 3): WeakTopic[] {
  return profile.weakTopics.filter((t) => t.weaknessScore > 0).slice(0, n);
}

/**
 * Determine if a specific topic is considered "critical" weakness.
 */
export function isTopicCritical(profile: WeaknessProfile, topic: string): boolean {
  const found = profile.weakTopics.find((t) => t.topic === topic);
  return found ? found.weaknessScore >= CRITICAL_THRESHOLD : false;
}

/**
 * Summarize weakness profile into a short Arabic string for display.
 */
export function summarizeWeakness(profile: WeaknessProfile): string {
  if (!profile.hasEnoughData) return 'لا توجد بيانات كافية لتحليل نقاط الضعف بعد.';
  if (profile.criticalTopicCount === 0) return 'أداء ممتاز! لا توجد نقاط ضعف حرجة.';
  const top = getTopWeakTopics(profile, 2).map((t) => t.topic).join('، ');
  return `نقاط ضعف رئيسية في: ${top}`;
}
