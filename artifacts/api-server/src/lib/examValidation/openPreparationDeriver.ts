/**
 * examValidation/openPreparationDeriver.ts
 *
 * Derives preparation packages for open-ended question types (short_answer,
 * calculation, essay) using curriculum evidence as the sole authority.
 *
 * Called ONCE per question during preparation — never during grading.
 * The stored package fully describes how to grade the question deterministically.
 *
 * Question-type specific outputs:
 *
 *   short_answer  → canonicalAnswer + acceptedSemanticAnswers + requiredConcepts
 *                   + scientificGuardTerms + acceptedKeywords
 *
 *   calculation   → canonicalAnswer + formula + expectedNumericResult
 *                   + numericTolerance + acceptedUnits + requiredConcepts
 *
 *   essay         → rubric ONLY (no rigid answer):
 *                   requiredConcepts + requiredEvidence + expectedStructure
 *                   + scoringCriteria + scientificGuardConcepts
 *
 * Re-exports DailyQuotaExhaustedError so the pipeline can stop cleanly.
 */

import { logger } from '../logger';
import type { PipelineQuestion, EvidenceChunk } from './types';
import { DailyQuotaExhaustedError } from './canonicalAnswerDeriver';

export { DailyQuotaExhaustedError };

// ─── Package types (stored as JSONB) ─────────────────────────────────────────

export interface ShortAnswerPackage {
  type: 'short_answer';
  canonicalAnswer: string;
  acceptedSemanticAnswers: string[];
  requiredConcepts: string[];
  scientificGuardTerms: string[];
  acceptedKeywords: string[];
}

export interface CalculationPackage {
  type: 'calculation';
  canonicalAnswer: string;
  formula: string;
  expectedNumericResult: number | null;
  numericTolerance: number;
  acceptedUnits: string[];
  acceptedFormats: string[];
  alternativeSolutionMethods: string[];
  requiredConcepts: string[];
}

export interface EssayPackage {
  type: 'essay';
  requiredConcepts: string[];
  requiredEvidence: string[];
  expectedStructure: string;
  scoringCriteria: string[];
  scientificGuardConcepts: string[];
}

export type OpenPreparationPackage =
  | ShortAnswerPackage
  | CalculationPackage
  | EssayPackage;

// ─── Gemini config ────────────────────────────────────────────────────────────

const GEMINI_BASE       = 'https://generativelanguage.googleapis.com';
const MODEL             = 'gemini-2.5-flash';
const MAX_OUTPUT_TOKENS = 2_048;
const TEMPERATURE       = 0.0;

const RATE_LIMIT_DELAYS  = [5_000, 15_000, 30_000, 60_000];
const UNAVAILABLE_DELAYS = [2_000, 8_000, 20_000];

/** Minimum evidence confidence to attempt derivation. */
export const OPEN_PREP_CONFIDENCE_THRESHOLD = 0.17; // at least 1 of 6 chunks

// ─── Prompt builders ─────────────────────────────────────────────────────────

function buildEvidenceText(evidence: EvidenceChunk[]): string {
  return evidence
    .map((c, i) =>
      `--- مقطع ${i + 1} (${c.chapter || 'غير محدد'}، صفحة ${c.pageRange || '؟'}) ---\n${c.content}`
    )
    .join('\n\n');
}

function buildShortAnswerPrompt(q: PipelineQuestion, evidence: EvidenceChunk[]): string {
  return `\
أنت نظام متخصص في إعداد مفاتيح تصحيح أسئلة الإجابة القصيرة من المحتوى المنهجي العربي.

السؤال:
${q.question}
${q.correctAnswer ? `\nالإجابة المخزنة (إن وجدت): ${q.correctAnswer}` : ''}

المحتوى المنهجي المرجعي:
${buildEvidenceText(evidence)}

التعليمات:
- استخرج الإجابة النموذجية الكاملة من المحتوى المنهجي فقط.
- اجمع صياغات مقبولة متعددة للإجابة الصحيحة.
- استخرج المفاهيم الأساسية التي يجب أن تتضمنها إجابة الطالب.
- استخرج المصطلحات العلمية الحاسمة التي تدل على الفهم الصحيح.
- اجمع الكلمات المفتاحية المقبولة الدالة على الإجابة الصحيحة.
- إذا لم يكن المحتوى المنهجي كافياً، أعد confidence أقل من 0.5.

أعد JSON فقط بهذا الشكل:
{
  "canonicalAnswer": "الإجابة النموذجية الكاملة",
  "acceptedSemanticAnswers": ["صياغة بديلة 1", "صياغة بديلة 2"],
  "requiredConcepts": ["مفهوم 1", "مفهوم 2"],
  "scientificGuardTerms": ["مصطلح علمي 1", "مصطلح علمي 2"],
  "acceptedKeywords": ["كلمة مفتاحية 1", "كلمة مفتاحية 2"],
  "confidence": 0.0,
  "reasoning": "شرح مختصر من المحتوى المنهجي"
}`;
}

function buildCalculationPrompt(q: PipelineQuestion, evidence: EvidenceChunk[]): string {
  return `\
أنت نظام متخصص في إعداد مفاتيح تصحيح أسئلة الحساب والتطبيقات الرياضية من المحتوى المنهجي.

السؤال:
${q.question}
${q.correctAnswer ? `\nالإجابة المخزنة (إن وجدت): ${q.correctAnswer}` : ''}

المحتوى المنهجي المرجعي:
${buildEvidenceText(evidence)}

التعليمات:
- استخرج الإجابة الكاملة مع الوحدات.
- استخرج القانون أو المعادلة المستخدمة.
- استخرج القيمة العددية الصحيحة فقط (رقم عشري إن وجد).
- حدد هامش الخطأ المقبول (مثال: 0.01 = 1%).
- اجمع الوحدات المقبولة.
- اجمع طرق الحل البديلة.
- اجمع المفاهيم الأساسية المطلوبة.
- إذا لم يكن المحتوى المنهجي كافياً، أعد confidence أقل من 0.5.

أعد JSON فقط بهذا الشكل:
{
  "canonicalAnswer": "الإجابة الكاملة مع الوحدات",
  "formula": "القانون المستخدم",
  "expectedNumericResult": 0.0,
  "numericTolerance": 0.05,
  "acceptedUnits": ["وحدة 1", "وحدة 2"],
  "acceptedFormats": ["صيغة قبول 1"],
  "alternativeSolutionMethods": ["طريقة بديلة 1"],
  "requiredConcepts": ["مفهوم مطلوب 1"],
  "confidence": 0.0,
  "reasoning": "شرح مختصر"
}`;
}

function buildEssayPrompt(q: PipelineQuestion, evidence: EvidenceChunk[]): string {
  return `\
أنت نظام متخصص في إعداد معايير تقييم المقالات العلمية من المحتوى المنهجي.
مهمتك: إعداد مقياس تقييم (rubric) وليس إجابة نموذجية واحدة جامدة.

السؤال:
${q.question}
${q.correctAnswer ? `\nملاحظة: ${q.correctAnswer}` : ''}

المحتوى المنهجي المرجعي:
${buildEvidenceText(evidence)}

التعليمات:
- استخرج المفاهيم الأساسية التي يجب أن تتناولها الإجابة.
- استخرج الأدلة والشواهد من المنهج الداعمة للإجابة الصحيحة.
- صِف البنية المتوقعة للإجابة الجيدة.
- ضع معايير التصحيح التفصيلية (كل معيار = نقطة يمكن تقييمها).
- استخرج المفاهيم العلمية الحارسة التي تدل على الفهم الصحيح.
- إذا لم يكن المحتوى المنهجي كافياً، أعد confidence أقل من 0.5.

أعد JSON فقط بهذا الشكل:
{
  "requiredConcepts": ["مفهوم أساسي 1", "مفهوم أساسي 2"],
  "requiredEvidence": ["شاهد من المنهج 1", "شاهد من المنهج 2"],
  "expectedStructure": "وصف بنية الإجابة المتوقعة",
  "scoringCriteria": ["معيار 1: يذكر ...", "معيار 2: يشرح ..."],
  "scientificGuardConcepts": ["مفهوم حارس 1", "مفهوم حارس 2"],
  "confidence": 0.0,
  "reasoning": "شرح مختصر"
}`;
}

// ─── Gemini call ──────────────────────────────────────────────────────────────

async function callGemini(
  prompt: string,
  attempt = 0,
  unavailableAttempt = 0,
): Promise<string> {
  const apiKey = process.env['GEMINI_API_KEY'];
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');

  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS, temperature: TEMPERATURE },
  };

  const res = await fetch(
    `${GEMINI_BASE}/v1beta/models/${MODEL}:generateContent?key=${apiKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  );

  if (res.status === 429) {
    const data = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (isDailyQuota(data)) {
      throw new DailyQuotaExhaustedError(`Gemini daily quota exhausted: ${JSON.stringify(data)}`);
    }
    if (attempt < RATE_LIMIT_DELAYS.length) {
      await sleep(RATE_LIMIT_DELAYS[attempt]!);
      return callGemini(prompt, attempt + 1, unavailableAttempt);
    }
    throw new Error(`Gemini 429 (max retries): ${JSON.stringify(data)}`);
  }

  if (res.status === 503) {
    if (unavailableAttempt < UNAVAILABLE_DELAYS.length) {
      await sleep(UNAVAILABLE_DELAYS[unavailableAttempt]!);
      return callGemini(prompt, attempt, unavailableAttempt + 1);
    }
    throw new Error('Gemini 503 (max retries exceeded)');
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Gemini error ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json() as Record<string, unknown>;
  const candidates = data['candidates'] as Array<Record<string, unknown>> | undefined;
  const text = (candidates?.[0]?.['content'] as Record<string, unknown> | undefined)
    ?.['parts'] as Array<Record<string, unknown>> | undefined;
  return (text?.[0]?.['text'] as string) ?? '';
}

function isDailyQuota(data: Record<string, unknown>): boolean {
  const str = JSON.stringify(data).toLowerCase();
  return str.includes('quota') && (str.includes('day') || str.includes('daily') || str.includes('exhausted'));
}

// ─── Response parsing ─────────────────────────────────────────────────────────

function parseJsonResponse(raw: string): Record<string, unknown> | null {
  const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  try {
    return JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]) as Record<string, unknown>; } catch { /* fall through */ }
    }
    return null;
  }
}

function toStringArray(val: unknown): string[] {
  if (!Array.isArray(val)) return [];
  return val.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
}

function toNumber(val: unknown, fallback: number): number {
  if (typeof val === 'number' && !isNaN(val)) return val;
  if (typeof val === 'string') {
    const n = parseFloat(val);
    if (!isNaN(n)) return n;
  }
  return fallback;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface OpenDerivationResult {
  package:   OpenPreparationPackage;
  confidence: number;
  reasoning:  string;
}

/**
 * Derive a preparation package for one open-ended question.
 * Called once during preparation — NEVER during grading.
 *
 * Throws DailyQuotaExhaustedError if Gemini daily limit is hit.
 */
export async function deriveOpenPreparation(
  question:  PipelineQuestion,
  evidence:  EvidenceChunk[],
): Promise<OpenDerivationResult | null> {
  const { questionType } = question;

  let prompt: string;
  if (questionType === 'short_answer') {
    prompt = buildShortAnswerPrompt(question, evidence);
  } else if (questionType === 'calculation') {
    prompt = buildCalculationPrompt(question, evidence);
  } else if (questionType === 'essay') {
    prompt = buildEssayPrompt(question, evidence);
  } else {
    logger.warn({ questionType }, 'openPreparationDeriver: unsupported type');
    return null;
  }

  let raw: string;
  try {
    raw = await callGemini(prompt);
  } catch (err) {
    if (err instanceof DailyQuotaExhaustedError) throw err;
    logger.error({ err, questionId: question.id, questionType }, 'openPreparationDeriver: Gemini call failed');
    return null;
  }

  const parsed = parseJsonResponse(raw);
  if (!parsed) {
    logger.warn({ questionId: question.id, raw: raw.slice(0, 200) }, 'openPreparationDeriver: could not parse response');
    return null;
  }

  const confidence = toNumber(parsed['confidence'], 0);
  const reasoning  = typeof parsed['reasoning'] === 'string' ? parsed['reasoning'] : '';

  let pkg: OpenPreparationPackage;

  if (questionType === 'short_answer') {
    const canonicalAnswer = typeof parsed['canonicalAnswer'] === 'string' ? parsed['canonicalAnswer'].trim() : '';
    if (!canonicalAnswer) {
      logger.warn({ questionId: question.id }, 'openPreparationDeriver: short_answer missing canonicalAnswer');
      return null;
    }
    pkg = {
      type:                    'short_answer',
      canonicalAnswer,
      acceptedSemanticAnswers: toStringArray(parsed['acceptedSemanticAnswers']),
      requiredConcepts:        toStringArray(parsed['requiredConcepts']),
      scientificGuardTerms:    toStringArray(parsed['scientificGuardTerms']),
      acceptedKeywords:        toStringArray(parsed['acceptedKeywords']),
    } satisfies ShortAnswerPackage;
  } else if (questionType === 'calculation') {
    const canonicalAnswer = typeof parsed['canonicalAnswer'] === 'string' ? parsed['canonicalAnswer'].trim() : '';
    if (!canonicalAnswer) {
      logger.warn({ questionId: question.id }, 'openPreparationDeriver: calculation missing canonicalAnswer');
      return null;
    }
    const rawNumeric = parsed['expectedNumericResult'];
    const expectedNumericResult = (rawNumeric === null || rawNumeric === undefined)
      ? null
      : toNumber(rawNumeric, NaN);
    pkg = {
      type:                       'calculation',
      canonicalAnswer,
      formula:                    typeof parsed['formula'] === 'string' ? parsed['formula'] : '',
      expectedNumericResult:      (expectedNumericResult !== null && !isNaN(expectedNumericResult)) ? expectedNumericResult : null,
      numericTolerance:           toNumber(parsed['numericTolerance'], 0.05),
      acceptedUnits:              toStringArray(parsed['acceptedUnits']),
      acceptedFormats:            toStringArray(parsed['acceptedFormats']),
      alternativeSolutionMethods: toStringArray(parsed['alternativeSolutionMethods']),
      requiredConcepts:           toStringArray(parsed['requiredConcepts']),
    } satisfies CalculationPackage;
  } else {
    // essay
    pkg = {
      type:                   'essay',
      requiredConcepts:       toStringArray(parsed['requiredConcepts']),
      requiredEvidence:       toStringArray(parsed['requiredEvidence']),
      expectedStructure:      typeof parsed['expectedStructure'] === 'string' ? parsed['expectedStructure'] : '',
      scoringCriteria:        toStringArray(parsed['scoringCriteria']),
      scientificGuardConcepts:toStringArray(parsed['scientificGuardConcepts']),
    } satisfies EssayPackage;
  }

  logger.info(
    { questionId: question.id, questionType, confidence },
    'openPreparationDeriver: package derived',
  );

  return { package: pkg, confidence, reasoning };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
