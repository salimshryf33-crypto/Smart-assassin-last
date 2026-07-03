/**
 * correctionEngine/curriculumGrader.ts
 *
 * Stages 2–6 of the Curriculum Authority Correction Pipeline:
 *
 *   Stage 2 — VALIDATE EVIDENCE   (via EvidenceRetriever.validateEvidence)
 *   Stage 3 — BUILD CORRECTION PACKAGE   (explicit named struct + logging)
 *   Stage 4 — GEMINI SEMANTIC ANALYSIS   (evidence-only, no external knowledge)
 *   Stage 5 — BACKEND VERIFICATION       (sanity-check Gemini output)
 *   Stage 6 — FINAL GRADE                (isCorrect + scoreRatio derived here)
 *
 * CRITICAL RESTRICTIONS (enforced by prompt engineering + backend verification):
 *  - Gemini receives ONLY the Correction Package built by the backend.
 *  - Gemini NEVER receives a general instruction to "use your knowledge".
 *  - Gemini is instructed to return INSUFFICIENT if evidence is unclear.
 *  - External scientific facts MUST NOT enter the correction via this path.
 *  - The backend verifies and clamps Gemini output before accepting it.
 *
 * Applies to: short_answer, essay, calculation, reasoning, inference,
 *             definition, and any open-ended type not in DETERMINISTIC_TYPES.
 *
 * Partial credit (Phase 1.5):
 *   Gemini returns scoreRatio 0.0–1.0.
 *   isCorrect = scoreRatio >= 0.5.
 *   scorePct at attempt level is the weighted average of all scoreRatios.
 */

import { logger }             from '../logger';
import { EvidenceRetriever }  from './evidenceRetriever';
import type {
  CorrectionPackage,
  CorrectionResult,
  CurriculumEvidence,
  QuestionCorrectionInput,
} from './types';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com';
const MODEL       = 'gemini-2.5-flash';
// 2048 tokens is generous for a 3-field JSON with Arabic feedback and chapter citation.
const MAX_TOKENS  = 2048;
const TEMPERATURE = 0.05; // near-zero: evaluator, not generator

// Threshold above which a scoreRatio is considered "correct"
const CORRECT_THRESHOLD = 0.5;
// If Gemini claims high confidence (>0.8) but evidence confidence is weak, cap the score
const HIGH_SCORE_CAP_EVIDENCE_THRESHOLD = 0.4;
const HIGH_SCORE_CAP_VALUE              = 0.7;

// ─── Stage 3: Build Correction Package ───────────────────────────────────────

/**
 * Stage 3 — BUILD CORRECTION PACKAGE.
 *
 * Assembles all educational inputs into a single named struct.
 * This is the ONLY object that reaches Gemini.
 * Logged at INFO level before dispatch so the backend has a full audit trail.
 */
function buildCorrectionPackage(
  input:    QuestionCorrectionInput,
  evidence: CurriculumEvidence
): CorrectionPackage {
  return {
    question:             input.question,
    questionType:         input.questionType,
    studentAnswer:        input.studentAnswer ?? '',
    correctAnswer:        input.correctAnswer,
    topic:                input.topic,
    chapter:              input.chapter,
    evidence,
    curriculumConfidence: evidence.confidence,
    linkedDocId:          evidence.chunks[0]?.docId,
  };
}

// ─── Stage 4: Gemini prompt construction ─────────────────────────────────────

function buildEvidenceBlock(evidence: CurriculumEvidence): string {
  return evidence.chunks
    .map((c, i) =>
      `[دليل ${i + 1}${c.chapter ? ` — ${c.chapter}` : ''}${c.pageRange ? ` | الصفحات: ${c.pageRange}` : ''}]\n${c.content}`
    )
    .join('\n\n---\n\n');
}

/**
 * Builds the prompt that is sent to Gemini.
 * Gemini receives ONLY the Correction Package contents — no general knowledge permitted.
 * Returns scoreRatio (0.0–1.0) enabling partial credit.
 */
function buildPrompt(pkg: CorrectionPackage): string {
  const evidenceBlock = buildEvidenceBlock(pkg.evidence);
  const modelAnswer   = pkg.correctAnswer
    ? `\nالإجابة النموذجية: ${pkg.correctAnswer}`
    : '';
  const topicLine     = pkg.chapter
    ? `الفصل: ${pkg.chapter}${pkg.topic ? ` — الموضوع: ${pkg.topic}` : ''}`
    : (pkg.topic ? `الموضوع: ${pkg.topic}` : '');

  return `أنت محلل دلالي تعليمي. مهمتك الوحيدة: تقييم إجابة الطالب حصراً بناءً على أدلة المنهج المقدمة أدناه.

══════════════════ القواعد الصارمة ══════════════════
1. استخدم فقط الأدلة المقدمة في هذا الطلب — ممنوع تماماً استخدام أي معرفة علمية عامة أو خارجية أو افتراضات من بيانات التدريب.
2. إذا لم تكفِ الأدلة للحكم، أعد scoreRatio: 0 و feedback: "لا يمكن تقييم الإجابة بناءً على المنهج المتاح."
3. ركّز على الصحة المفاهيمية لا على الصياغة الحرفية — المعنى العلمي المكافئ يستحق الدرجة الكاملة.
4. يجب أن يذكر الـ feedback الفصل أو المفهوم المحدد من الأدلة (مثال: "وفقاً للفصل الثاني: ...").
5. أعد JSON فقط بدون markdown ولا نص إضافي.

══════════════════ سلّم التقييم (scoreRatio) ══════════════════
1.0   — إجابة كاملة وصحيحة، تغطي جميع النقاط الجوهرية من الأدلة
0.7–0.9 — إجابة صحيحة لكن ناقصة (نقطة أو مفهوم مفقود)
0.5–0.69 — إجابة جزئية، تغطي النصف أو أكثر من النقاط الجوهرية
0.1–0.49 — فهم ضعيف أو إجابة خاطئة جزئياً
0.0   — إجابة خاطئة تماماً أو غائبة

══════════════════ أدلة المنهج الدراسي ══════════════════
${evidenceBlock}

══════════════════ السؤال ══════════════════
${topicLine ? topicLine + '\n' : ''}${pkg.question}${modelAnswer}

══════════════════ إجابة الطالب ══════════════════
${pkg.studentAnswer || '(لا توجد إجابة)'}

الرد المطلوب (JSON فقط — لا markdown، لا نص إضافي):
{
  "scoreRatio": <رقم بين 0.0 و 1.0>,
  "feedback": "<تعليق بالعربي يذكر الفصل أو المفهوم من الأدلة>"
}`;
}

// ─── Stage 4: Gemini call ─────────────────────────────────────────────────────

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

// ─── Stage 5: Backend Verification ───────────────────────────────────────────

interface GeminiGradingResponse {
  scoreRatio: number;
  feedback:   string;
}

/**
 * Stage 5 — BACKEND VERIFICATION.
 *
 * Verifies and sanitises Gemini's response before it becomes a final grade.
 * The backend always has the final authority — Gemini is only an analyzer.
 *
 * Checks:
 *  1. scoreRatio is a valid number (clamp to [0, 1])
 *  2. If Gemini claims high score (>0.8) but evidence confidence is weak,
 *     cap the score to prevent hallucination-driven false positives
 *  3. feedback is a non-empty string
 */
function verifyGeminiResponse(
  raw:      GeminiGradingResponse,
  evidence: CurriculumEvidence,
  questionId: string
): GeminiGradingResponse {
  let { scoreRatio, feedback } = raw;

  // 1. Clamp scoreRatio to valid range [0, 1]
  if (typeof scoreRatio !== 'number' || isNaN(scoreRatio)) {
    logger.warn({ questionId, rawScoreRatio: raw.scoreRatio },
      'correctionEngine: verification — scoreRatio invalid, defaulting to 0');
    scoreRatio = 0;
  } else {
    scoreRatio = Math.max(0, Math.min(1, scoreRatio));
  }

  // 2. Cap high scores when evidence confidence is insufficient
  //    (Prevents Gemini from confidently marking correct when evidence is thin)
  if (scoreRatio > 0.8 && evidence.confidence < HIGH_SCORE_CAP_EVIDENCE_THRESHOLD) {
    logger.info(
      {
        questionId,
        originalScore:       scoreRatio,
        cappedScore:         HIGH_SCORE_CAP_VALUE,
        evidenceConfidence:  evidence.confidence.toFixed(2),
      },
      'correctionEngine: verification — high score capped due to low evidence confidence'
    );
    scoreRatio = HIGH_SCORE_CAP_VALUE;
  }

  // 3. Ensure feedback is a usable string
  if (typeof feedback !== 'string' || !feedback.trim()) {
    feedback = 'تم تقييم الإجابة بناءً على المنهج المتاح.';
  }

  return { scoreRatio, feedback };
}

// ─── Parse Gemini output ─────────────────────────────────────────────────────

function parseGeminiOutput(raw: string, questionId: string): GeminiGradingResponse | null {
  const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

  // Primary: full JSON parse
  try {
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    return {
      scoreRatio: typeof parsed['scoreRatio'] === 'number'
        ? parsed['scoreRatio']
        : (parsed['isCorrect'] === true ? 1.0 : 0.0), // backward compat if old format
      feedback: String(parsed['feedback'] ?? ''),
    };
  } catch {
    // Fallback: extract individual fields via regex when JSON is truncated or malformed.
    const scoreMatch     = cleaned.match(/"scoreRatio"\s*:\s*([\d.]+)/);
    const isCorrectMatch = cleaned.match(/"isCorrect"\s*:\s*(true|false)/i);
    const feedbackMatch  = cleaned.match(/"feedback"\s*:\s*"((?:[^"\\]|\\.)*)"/);

    if (scoreMatch || isCorrectMatch) {
      let scoreRatio = scoreMatch
        ? parseFloat(scoreMatch[1]!)
        : (isCorrectMatch?.[1]?.toLowerCase() === 'true' ? 1.0 : 0.0);
      if (isNaN(scoreRatio)) scoreRatio = 0;

      logger.warn({ questionId },
        'correctionEngine: JSON malformed — recovered via regex fallback');

      return {
        scoreRatio,
        feedback: feedbackMatch?.[1]?.replace(/\\"/g, '"') ?? '',
      };
    }
  }

  return null;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Grade an open-ended answer using curriculum evidence as the sole authority.
 *
 * Full pipeline:
 *   Stage 2 → validateEvidence()        (relevance + confidence checks)
 *   Stage 3 → buildCorrectionPackage()  (named struct, logged)
 *   Stage 4 → callGemini()              (semantic analysis, evidence-only)
 *   Stage 5 → verifyGeminiResponse()    (backend verification + capping)
 *   Stage 6 → derive isCorrect + return CorrectionResult
 */
export async function gradeWithCurriculum(
  input:    QuestionCorrectionInput,
  evidence: CurriculumEvidence
): Promise<CorrectionResult> {

  // ── Guard: empty answer ──────────────────────────────────────────────────
  if (!input.studentAnswer?.trim()) {
    return {
      isCorrect:      false,
      scoreRatio:     0,
      gradingMethod:  'skipped',
      aiFeedback:     'لم تقدم إجابة.',
      evidenceStatus: 'SKIPPED',
      evidence:       null,
    };
  }

  // ── Stage 2: Validate Evidence ───────────────────────────────────────────
  const validation = EvidenceRetriever.validateEvidence(evidence, input.question);

  if (!validation.isValid) {
    logger.warn(
      {
        questionId:  input.questionId,
        reason:      validation.reason,
        confidence:  evidence.confidence,
        chunksFound: evidence.chunks.length,
      },
      'correctionEngine: Stage 2 validation failed — skipping AI call'
    );
    return {
      isCorrect:      false,
      scoreRatio:     0,
      gradingMethod:  'insufficient',
      aiFeedback:     validation.message ?? 'تعذر تصحيح هذه الإجابة لعدم توفر دليل كافٍ من المنهج الدراسي.',
      evidenceStatus: 'INSUFFICIENT_CURRICULUM_EVIDENCE',
      evidence,
    };
  }

  // ── Stage 3: Build Correction Package ────────────────────────────────────
  const pkg = buildCorrectionPackage(input, evidence);

  logger.info(
    {
      questionId:          input.questionId,
      questionType:        pkg.questionType,
      chapter:             pkg.chapter,
      topic:               pkg.topic,
      evidenceChunks:      pkg.evidence.chunks.length,
      curriculumConfidence: pkg.curriculumConfidence.toFixed(2),
      linkedDocId:         pkg.linkedDocId,
      studentAnswerLen:    pkg.studentAnswer.length,
    },
    'correctionEngine: Stage 3 — Correction Package built'
  );

  // ── Stage 4: Gemini Semantic Analysis ────────────────────────────────────
  const prompt = buildPrompt(pkg);

  try {
    const rawText = await callGemini(prompt);
    const parsed  = parseGeminiOutput(rawText, input.questionId);

    if (!parsed) {
      throw new Error('Could not parse Gemini grading response');
    }

    // ── Stage 5: Backend Verification ──────────────────────────────────────
    const verified = verifyGeminiResponse(parsed, evidence, input.questionId);

    // ── Stage 6: Final Grade ────────────────────────────────────────────────
    const isCorrect = verified.scoreRatio >= CORRECT_THRESHOLD;

    logger.info(
      {
        questionId:  input.questionId,
        scoreRatio:  verified.scoreRatio,
        isCorrect,
        strategy:    evidence.strategy,
      },
      'correctionEngine: Stage 6 — final grade determined'
    );

    return {
      isCorrect,
      scoreRatio:     verified.scoreRatio,
      gradingMethod:  'ai',
      aiFeedback:     verified.feedback,
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
      scoreRatio:     0,
      gradingMethod:  'ai',
      aiFeedback:     'تعذر التصحيح التلقائي.',
      evidenceStatus: 'FOUND',
      evidence,
    };
  }
}
