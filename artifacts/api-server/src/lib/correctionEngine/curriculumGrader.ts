/**
 * correctionEngine/curriculumGrader.ts
 *
 * Responsible ONLY for semantic correction using Gemini as an evaluator.
 *
 * CRITICAL RESTRICTIONS (enforced by prompt engineering):
 *  - Gemini receives ONLY: question + student answer + curriculum evidence.
 *  - Gemini NEVER receives a general instruction to "use your knowledge".
 *  - Gemini is instructed to return INSUFFICIENT if evidence is unclear.
 *  - External scientific facts MUST NOT enter the correction via this path.
 *
 * Applies to: short_answer, essay, calculation, reasoning, inference,
 *             definition, and any open-ended type not in DETERMINISTIC_TYPES.
 *
 * If curriculum evidence is insufficient → returns INSUFFICIENT_CURRICULUM_EVIDENCE
 * without calling Gemini. This prevents hallucination entirely.
 */

import { logger }                from '../logger';
import { EvidenceRetriever }     from './evidenceRetriever';
import type {
  CorrectionResult,
  CurriculumEvidence,
  QuestionCorrectionInput,
} from './types';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com';
const MODEL       = 'gemini-2.5-flash';
const MAX_TOKENS  = 512;
const TEMPERATURE = 0.05; // near-zero: evaluator, not generator

// ─── Gemini helper ────────────────────────────────────────────────────────────

async function callGemini(prompt: string): Promise<string> {
  const apiKey = process.env['GEMINI_API_KEY'];
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');

  const res = await fetch(
    `${GEMINI_BASE}/v1beta/models/${MODEL}:generateContent?key=${apiKey}`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: MAX_TOKENS, temperature: TEMPERATURE },
      }),
    }
  );

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Gemini HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}

// ─── Prompt construction ──────────────────────────────────────────────────────

function buildEvidenceBlock(evidence: CurriculumEvidence): string {
  return evidence.chunks
    .map((c, i) =>
      `[دليل ${i + 1}${c.chapter ? ` — ${c.chapter}` : ''}]\n${c.content}`
    )
    .join('\n\n---\n\n');
}

function buildPrompt(
  input:    QuestionCorrectionInput,
  evidence: CurriculumEvidence
): string {
  const evidenceBlock = buildEvidenceBlock(evidence);
  const modelAnswer   = input.correctAnswer
    ? `\nالإجابة النموذجية: ${input.correctAnswer}`
    : '';

  return `أنت مصحح امتحانات. مهمتك فقط: تقييم إجابة الطالب بناءً على أدلة المنهج المقدمة أدناه.

قواعد صارمة لا يمكن تجاوزها:
1. استخدم فقط الأدلة المقدمة — ممنوع استخدام أي معرفة علمية عامة أو خارجية.
2. إذا لم تكفِ الأدلة للحكم، أعد feedback: "لا يمكن تقييم الإجابة بناءً على المنهج المتاح."
3. ركّز على الصحة المفاهيمية لا على الصياغة الحرفية.
4. للمقالات: isCorrect=true إذا غطّت الإجابة النقاط الجوهرية الموجودة في الأدلة.
5. feedback يكون مختصراً ومستنداً إلى الأدلة (جملة أو جملتان).
6. أعد JSON فقط بدون markdown ولا نص إضافي.

═══ أدلة من المنهج الدراسي ═══
${evidenceBlock}

═══ السؤال ═══
${input.question}${modelAnswer}

═══ إجابة الطالب ═══
${input.studentAnswer ?? '(لا توجد إجابة)'}

الرد المطلوب (JSON فقط):
{
  "isCorrect": true أو false,
  "feedback": "تعليق بالعربي مستند للمنهج"
}`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Grade an open-ended answer using curriculum evidence as the sole authority.
 *
 * Decision flow:
 *   1. Empty answer          → skipped (no Gemini)
 *   2. Insufficient evidence → INSUFFICIENT_CURRICULUM_EVIDENCE (no Gemini)
 *   3. Sufficient evidence   → Gemini evaluates against supplied evidence only
 */
export async function gradeWithCurriculum(
  input:    QuestionCorrectionInput,
  evidence: CurriculumEvidence
): Promise<CorrectionResult> {
  // 1. Empty answer
  if (!input.studentAnswer?.trim()) {
    return {
      isCorrect:      false,
      gradingMethod:  'skipped',
      aiFeedback:     'لم تقدم إجابة.',
      evidenceStatus: 'SKIPPED',
      evidence:       null,
    };
  }

  // 2. Insufficient curriculum evidence → never guess, never hallucinate
  if (!EvidenceRetriever.isSufficient(evidence)) {
    logger.warn(
      {
        questionId:  input.questionId,
        confidence:  evidence.confidence,
        chunksFound: evidence.chunks.length,
      },
      'correctionEngine: insufficient curriculum evidence — skipping AI call'
    );
    return {
      isCorrect:      false,
      gradingMethod:  'ai',
      aiFeedback:     'تعذر تصحيح هذه الإجابة لعدم توفر دليل كافٍ من المنهج الدراسي.',
      evidenceStatus: 'INSUFFICIENT_CURRICULUM_EVIDENCE',
      evidence,
    };
  }

  // 3. Gemini evaluation — strictly against curriculum evidence only
  const prompt = buildPrompt(input, evidence);

  try {
    const raw     = await callGemini(prompt);
    const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed  = JSON.parse(cleaned) as { isCorrect?: boolean; feedback?: string };

    return {
      isCorrect:      parsed.isCorrect  ?? false,
      gradingMethod:  'ai',
      aiFeedback:     parsed.feedback   ?? '',
      evidenceStatus: 'FOUND',
      evidence,
    };
  } catch (err) {
    logger.error(
      { err, questionId: input.questionId },
      'correctionEngine: Gemini call failed'
    );
    return {
      isCorrect:      false,
      gradingMethod:  'ai',
      aiFeedback:     'تعذر التصحيح التلقائي.',
      evidenceStatus: 'FOUND',
      evidence,
    };
  }
}
