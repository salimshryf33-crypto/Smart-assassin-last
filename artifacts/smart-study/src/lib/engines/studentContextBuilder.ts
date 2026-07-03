/**
 * STUDENT LEARNING CONTEXT BUILDER — Phase 3 AI Teacher Intelligence
 *
 * Builds a TEMPORARY per-request student learning context from existing Sage data.
 *
 * Context is built from:
 *   - WeaknessProfile (computed from flashcards + comprehension checks — no API call)
 *
 * CRITICAL RULES:
 *   - Context is NEVER stored permanently.
 *   - Context lives ONLY during the request lifecycle (build → inject → discard).
 *   - No new API calls. No new DB tables. Zero permanent storage.
 *   - If no data exists → returns a "no-data" context that injects nothing.
 *   - Recommendations only come from actual weakness data — never invented.
 */

import type { WeaknessProfile } from './weaknessEngine';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StudentLearningContext {
  /** Top weak topics (weaknessScore > 0.1), max 5, sorted weakest-first */
  weakTopics: Array<{
    topic: string;
    weaknessScore: number;
    /** true when weaknessScore ≥ 0.6 — needs urgent attention */
    isCritical: boolean;
    /** Number of mistake-sourced cards for this topic */
    mistakeCount: number;
  }>;
  /** Topics the student handles well (score ≤ 0.1 with ≥2 reviewed cards) */
  strongTopics: Array<{ topic: string }>;
  /** Whether there is enough reviewed data to trust the profile (≥5 reviewed cards) */
  hasEnoughData: boolean;
  /** Total mistake-sourced flashcards — proxy for struggle intensity */
  totalMistakeCards: number;
  /** Teaching depth hint derived from the weakness profile */
  depthHint: 'detailed' | 'standard' | 'concise';
  /** Count of critical-weakness topics (score ≥ 0.6) */
  criticalCount: number;
}

// ─── Builder ──────────────────────────────────────────────────────────────────

/**
 * Build a temporary StudentLearningContext from a WeaknessProfile.
 *
 * Called ONCE per request inside the orchestrator.
 * The returned object is passed downstream to the answer engine and discarded
 * after the response is generated.
 */
export function buildStudentLearningContext(
  weakness: WeaknessProfile
): StudentLearningContext {
  const weakTopics = weakness.weakTopics
    .filter((t) => t.weaknessScore > 0.1)
    .slice(0, 5)
    .map((t) => ({
      topic:        t.topic,
      weaknessScore: t.weaknessScore,
      isCritical:   t.weaknessScore >= 0.6,
      mistakeCount: t.mistakeCount,
    }));

  const strongTopics = weakness.weakTopics
    .filter((t) => t.weaknessScore <= 0.1 && t.totalCards >= 2)
    .slice(0, 3)
    .map((t) => ({ topic: t.topic }));

  // Depth hint: if critical topics exist → ask for detailed explanations.
  // If student performs well across the board → concise is fine.
  const depthHint: 'detailed' | 'standard' | 'concise' =
    weakness.criticalTopicCount > 0
      ? 'detailed'
      : weakness.hasEnoughData &&
        weakness.criticalTopicCount === 0 &&
        weakness.totalMistakeCards === 0
      ? 'concise'
      : 'standard';

  return {
    weakTopics,
    strongTopics,
    hasEnoughData:    weakness.hasEnoughData,
    totalMistakeCards: weakness.totalMistakeCards,
    depthHint,
    criticalCount:    weakness.criticalTopicCount,
  };
}

// ─── Prompt Formatter ─────────────────────────────────────────────────────────

/**
 * Format the student learning context as a text block to append to the
 * teacher system prompt.
 *
 * Returns null when there is not enough data to personalise — the system prompt
 * is then used as-is without any context section (backward compatible).
 *
 * Rules enforced here (matching Phase 3 spec):
 *   1. Answer student's question FIRST — context only guides style, never interrupts.
 *   2. Recommendations come ONLY from real weakness data — never invented.
 *   3. Recommendations are OPTIONAL — teacher decides whether they are relevant.
 *   4. Context section is clearly marked "للمعلم فقط" — model must not expose it.
 */
export function formatStudentContextSection(ctx: StudentLearningContext): string | null {
  // Not enough reviewed data → don't inject anything
  if (!ctx.hasEnoughData || ctx.weakTopics.length === 0) return null;

  const parts: string[] = [];

  // ── Weak topics ────────────────────────────────────────────────────────────
  const weakList = ctx.weakTopics
    .map((t) => {
      const urgency = t.isCritical
        ? ` ⚠ (نقطة ضعف حرجة${t.mistakeCount > 0 ? ' — ' + t.mistakeCount + ' خطأ مسجل' : ''})`
        : '';
      return `  • ${t.topic}${urgency}`;
    })
    .join('\n');
  parts.push(`مواضيع تحتاج تعزيزاً (مرتبة من الأضعف):\n${weakList}`);

  // ── Strong topics (only if any) ────────────────────────────────────────────
  if (ctx.strongTopics.length > 0) {
    const strongList = ctx.strongTopics.map((t) => `  • ${t.topic}`).join('\n');
    parts.push(`مواضيع يتقنها الطالب (لا داعي لتكرار أساسياتها):\n${strongList}`);
  }

  // ── Depth instruction ──────────────────────────────────────────────────────
  if (ctx.depthHint === 'detailed') {
    parts.push('إرشاد العمق: الطالب يحتاج شرحاً تفصيلياً — تمهَّل في الشرح ولا تختصر المفاهيم الأساسية.');
  } else if (ctx.depthHint === 'concise') {
    parts.push('إرشاد العمق: الطالب متقدم — يمكن الاختصار وتجنب تكرار المبادئ الأولية.');
  }

  const contextBlock = [
    '==================================================',
    'السياق التعليمي للطالب (للمعلم فقط — لا تعرضه للطالب)',
    '==================================================',
    parts.join('\n\n'),
  ].join('\n');

  // ── Recommendation guidance ────────────────────────────────────────────────
  // Strict rules: answer first, recommendations are optional + relevant only.
  const recommendationGuide = [
    '==================================================',
    'توجيه التوصيات (اختياري — اقرأ القواعد):',
    '1. أجب على سؤال الطالب أولاً وكاملاً — لا تقاطع الشرح أبداً.',
    '2. بعد الانتهاء من الإجابة، يمكنك إضافة قسم "💡 توصية المعلم" (جملتان كحد أقصى) فقط إذا:',
    '   - كان الموضوع المطروح يمس مباشرةً أحد مواضيع الضعف المذكورة أعلاه.',
    '   - أو كان هناك موضوع مرتبط مباشرةً يستحق المراجعة القريبة.',
    '3. لا تضف التوصية إذا لم تكن ذات صلة واضحة بسؤال الطالب.',
    '4. لا تغير موضوع الدرس. لا تُنهِ الشرح مبكراً.',
    '5. لا تخترع نقاط ضعف — اعتمد فقط على البيانات المذكورة أعلاه.',
    '==================================================',
  ].join('\n');

  return `\n\n${contextBlock}\n\n${recommendationGuide}`;
}
