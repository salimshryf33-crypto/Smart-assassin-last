/**
 * examValidation/canonicalAnswerDeriver.ts
 *
 * Derives the correct MCQ option for a question using curriculum evidence
 * retrieved via Hybrid RAG.
 *
 * Pipeline:
 *   1. Build Arabic prompt with question + options + evidence chunks
 *   2. Call Gemini (gemini-2.5-flash, temperature=0 for determinism)
 *   3. Parse JSON response → { correctOption, confidence, reasoning }
 *   4. Validate correctOption is one of the listed options
 *
 * Follows the same rate-limit / quota handling pattern as questionExtractor.ts.
 * Re-throws DailyQuotaExhaustedError so the pipeline can stop cleanly.
 */

import { logger } from '../logger';
import type { PipelineQuestion, EvidenceChunk, DerivationResult } from './types';

// ─── Quota / rate-limit error ─────────────────────────────────────────────────

export class DailyQuotaExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DailyQuotaExhaustedError';
  }
}

// ─── Gemini config ────────────────────────────────────────────────────────────

const GEMINI_BASE      = 'https://generativelanguage.googleapis.com';
const MODEL            = 'gemini-2.5-flash';
const MAX_OUTPUT_TOKENS = 1_024;
const TEMPERATURE      = 0.0;   // deterministic for grading

// Backoff delays for per-minute rate limits (ms)
const RATE_LIMIT_DELAYS  = [5_000, 15_000, 30_000, 60_000];
// Backoff delays for 503 UNAVAILABLE (ms)
const UNAVAILABLE_DELAYS = [2_000, 8_000, 20_000];

// ─── Confidence threshold ─────────────────────────────────────────────────────

/** Minimum confidence to consider an answer READY. */
export const CONFIDENCE_THRESHOLD = 0.70;

// ─── Prompt builder ───────────────────────────────────────────────────────────

function buildDerivationPrompt(
  question:  PipelineQuestion,
  evidence:  EvidenceChunk[],
): string {
  const optionsRaw = parseOptions(question.options);
  const optionsList = optionsRaw
    ? optionsRaw.map((o, i) => `${i + 1}. ${o}`).join('\n')
    : '(لا توجد خيارات)';

  const evidenceText = evidence
    .map((c, i) =>
      `--- قطعة ${i + 1} (${c.chapter || 'غير محدد'}, صفحة ${c.pageRange || '؟'}) ---\n${c.content}`
    )
    .join('\n\n');

  return `\
أنت نظام متخصص في تحديد الإجابات الصحيحة لأسئلة الامتحانات من المحتوى المنهجي العربي.

مهمتك: بناءً على المحتوى المنهجي المرجعي فقط، حدد الإجابة الصحيحة للسؤال التالي.

════════════════════════════════════════
السؤال:
${question.question}

الخيارات:
${optionsList}
════════════════════════════════════════

المحتوى المنهجي المرجعي:
${evidenceText}

════════════════════════════════════════
التعليمات:
- حدد الخيار الصحيح بناءً على المحتوى المنهجي فقط، وليس من معرفتك العامة.
- اكتب الخيار كاملاً كما هو موجود في قائمة الخيارات أعلاه.
- إذا كان المحتوى المنهجي لا يدعم تحديد إجابة واضحة، اضبط confidence على قيمة أقل من 0.5.

أعد JSON فقط بهذا الشكل:
{
  "correctOption": "الخيار الصحيح كاملاً كما هو مكتوب في القائمة",
  "confidence": 0.0,
  "reasoning": "شرح مختصر من المحتوى المنهجي"
}`;
}

// ─── Gemini call (mirrors pattern in questionExtractor.ts) ────────────────────

async function callGemini(
  prompt:            string,
  attempt:           number = 0,
  unavailableAttempt:number = 0,
): Promise<string> {
  const apiKey = process.env['GEMINI_API_KEY'];
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');

  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS, temperature: TEMPERATURE },
  };

  const res = await fetch(
    `${GEMINI_BASE}/v1beta/models/${MODEL}:generateContent?key=${apiKey}`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    },
  );

  if (res.status === 429) {
    const data = await res.json().catch(() => ({})) as Record<string, unknown>;
    const bodyStr = JSON.stringify(data);

    if (isDailyQuota(data)) {
      logger.error(
        { attempt },
        'canonicalAnswerDeriver: daily Gemini quota exhausted',
      );
      throw new DailyQuotaExhaustedError(`Gemini daily quota exhausted: ${bodyStr}`);
    }

    if (attempt < RATE_LIMIT_DELAYS.length) {
      const delay = RATE_LIMIT_DELAYS[attempt]!;
      logger.warn(
        { attempt, delayMs: delay },
        'canonicalAnswerDeriver: rate-limited (429) — retrying after backoff',
      );
      await sleep(delay);
      return callGemini(prompt, attempt + 1, unavailableAttempt);
    }

    throw new Error(`Gemini 429 (max retries): ${bodyStr}`);
  }

  if (res.status === 503) {
    if (unavailableAttempt < UNAVAILABLE_DELAYS.length) {
      const delay = UNAVAILABLE_DELAYS[unavailableAttempt]!;
      logger.warn(
        { unavailableAttempt, delayMs: delay },
        'canonicalAnswerDeriver: 503 UNAVAILABLE — retrying',
      );
      await sleep(delay);
      return callGemini(prompt, attempt, unavailableAttempt + 1);
    }
    throw new Error('Gemini 503 (max retries exceeded)');
  }

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(`Gemini error ${res.status}: ${JSON.stringify(data)}`);
  }

  const data = await res.json() as Record<string, unknown>;
  const text = extractText(data);
  if (!text) throw new Error('Gemini returned empty response');
  return text;
}

// ─── Response parsing ─────────────────────────────────────────────────────────

function parseDerivationResponse(
  raw:     string,
  options: string[],
): DerivationResult | null {
  // Try direct JSON parse
  let parsed: Record<string, unknown> | null = null;

  try {
    parsed = JSON.parse(raw.trim()) as Record<string, unknown>;
  } catch {
    // Try extracting JSON from markdown code block
    const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (match?.[1]) {
      try {
        parsed = JSON.parse(match[1].trim()) as Record<string, unknown>;
      } catch {
        // fall through
      }
    }
  }

  if (!parsed) {
    // Last resort: regex extraction
    const correctMatch  = raw.match(/"correctOption"\s*:\s*"([^"]+)"/);
    const confidenceMatch = raw.match(/"confidence"\s*:\s*([0-9.]+)/);
    const reasoningMatch  = raw.match(/"reasoning"\s*:\s*"([^"]+)"/);

    if (correctMatch?.[1]) {
      parsed = {
        correctOption: correctMatch[1],
        confidence:    confidenceMatch ? parseFloat(confidenceMatch[1]) : 0,
        reasoning:     reasoningMatch?.[1] ?? '',
      };
    }
  }

  if (!parsed) return null;

  const correctOption = String(parsed['correctOption'] ?? '').trim();
  const confidence    = Number(parsed['confidence']    ?? 0);
  const reasoning     = String(parsed['reasoning']     ?? '').trim();

  if (!correctOption || isNaN(confidence)) return null;

  // Validate correctOption is one of the listed options (exact or substring)
  const matched = options.find(
    (o) => o.trim() === correctOption || o.includes(correctOption) || correctOption.includes(o.trim())
  );

  if (!matched) {
    logger.warn(
      { correctOption, options },
      'canonicalAnswerDeriver: correctOption not found in options list — discarding',
    );
    return null;
  }

  return {
    correctOption: matched,   // use the full option string from our list
    confidence:    Math.min(Math.max(confidence, 0), 1),
    reasoning,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Calls Gemini to derive the correct option for an MCQ question given
 * curriculum evidence.
 *
 * Returns null when:
 *   - No options on the question
 *   - Gemini response cannot be parsed
 *   - Derived option not among the listed options
 *
 * Throws DailyQuotaExhaustedError so the pipeline can stop cleanly.
 */
export async function deriveCanonicalAnswer(
  question: PipelineQuestion,
  evidence: EvidenceChunk[],
): Promise<DerivationResult | null> {
  const options = parseOptions(question.options);
  if (!options || options.length === 0) return null;

  const prompt = buildDerivationPrompt(question, evidence);

  logger.debug(
    { questionId: question.id, evidenceChunks: evidence.length },
    'canonicalAnswerDeriver: calling Gemini',
  );

  const raw = await callGemini(prompt);

  const result = parseDerivationResponse(raw, options);
  if (!result) {
    logger.warn(
      { questionId: question.id, raw: raw.slice(0, 300) },
      'canonicalAnswerDeriver: could not parse Gemini response',
    );
    return null;
  }

  logger.info(
    { questionId: question.id, confidence: result.confidence, correctOption: result.correctOption },
    'canonicalAnswerDeriver: derivation complete',
  );

  return result;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isDailyQuota(data: Record<string, unknown>): boolean {
  const str = JSON.stringify(data).toLowerCase();
  return str.includes('quota') || str.includes('exhausted') || str.includes('daily');
}

function extractText(data: Record<string, unknown>): string | null {
  try {
    const candidates = (data as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }).candidates;
    return candidates?.[0]?.content?.parts?.[0]?.text ?? null;
  } catch {
    return null;
  }
}

function parseOptions(raw: unknown): string[] | null {
  if (!raw) return null;
  if (Array.isArray(raw)) return raw as string[];
  if (typeof raw === 'string') {
    try {
      const p = JSON.parse(raw);
      return Array.isArray(p) ? p : null;
    } catch {
      return null;
    }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
