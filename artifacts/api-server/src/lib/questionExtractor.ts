/**
 * questionExtractor — AI-powered question extraction from exam chunks.
 *
 * Data flow (per the architecture plan):
 *   1. getDocMeta(docId)   → curriculumStorage [UNCHANGED]
 *   2. loadChunks(docId)   → curriculumStorage [UNCHANGED]
 *   3. upsertExamRecord(status:'extracting')
 *   4. batch chunks → Gemini API → JSON questions
 *   5. validate
 *   6. deduplicate
 *   7. saveQuestions(examId, [...])
 *   8. upsertExamRecord(status:'done')
 *
 * Architecture rule: this file never touches PostgreSQL directly.
 * All DB writes go through examStore.
 */
import { v4 as uuidv4 } from 'uuid';
import { getDocMeta, loadChunks } from './curriculumStorage';
import { examStore, examIdFromDocId } from './examStore';
import { logger } from './logger';
import { detectQuestionPatterns, analyzeOcrText } from './ocrQualityAnalyzer';
import type { InsertExamQuestion } from '@workspace/db';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com';

// ─── Gemini call ──────────────────────────────────────────────────────────────

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
  }>;
}

/** Backoff delays (ms) for 429 rate-limit retries (per-minute only). */
const RATE_LIMIT_DELAYS = [15_000, 30_000, 60_000];

/**
 * Thrown when the Gemini daily free-tier quota is exhausted.
 * Callers should stop processing immediately and not retry until next UTC day.
 */
export class DailyQuotaExhaustedError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'DailyQuotaExhaustedError';
  }
}

/** Returns true when the 429 body signals a per-day quota, not a per-minute rate limit. */
function isDailyQuota(body: unknown): boolean {
  const str = JSON.stringify(body);
  return str.includes('PerDay') || str.includes('per_day') || str.includes('RESOURCE_EXHAUSTED');
}

async function callGemini(prompt: string, attempt = 0): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');

  const res = await fetch(
    `${GEMINI_BASE}/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 32768, temperature: 0.1 },
      }),
    }
  );

  if (res.status === 429) {
    const data = await res.json().catch(() => ({}));

    // Daily quota exhausted — stop immediately, no retry
    if (isDailyQuota(data)) {
      logger.error(
        { attempt },
        'callGemini: daily free-tier quota exhausted — stopping extraction until tomorrow UTC'
      );
      throw new DailyQuotaExhaustedError(`Gemini daily quota exhausted: ${JSON.stringify(data)}`);
    }

    // Per-minute rate limit — retry with exponential backoff
    if (attempt < RATE_LIMIT_DELAYS.length) {
      const delay = RATE_LIMIT_DELAYS[attempt];
      logger.warn(
        { attempt, delayMs: delay },
        'callGemini: rate-limited (429) — retrying after backoff'
      );
      await new Promise((r) => setTimeout(r, delay));
      return callGemini(prompt, attempt + 1);
    }

    throw new Error(`Gemini error 429 (max retries exceeded): ${JSON.stringify(data)}`);
  }

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(`Gemini error ${res.status}: ${JSON.stringify(data)}`);
  }

  const data = (await res.json()) as GeminiResponse;
  return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}

// ─── Prompt ───────────────────────────────────────────────────────────────────

/** Compress long dot/underscore runs (fill-blank markers) to save tokens. */
function compressFillerDots(text: string): string {
  // Replace runs of 4+ dots with a short placeholder
  return text.replace(/\.{4,}/g, '....').replace(/_{4,}/g, '____');
}

function buildPrompt(chunkText: string, examTitle: string): string {
  const compressed = compressFillerDots(chunkText);
  return `أنت نظام استخراج أسئلة امتحانات للمحتوى التعليمي العربي.

استخرج كل الأسئلة من نص الامتحان التالي. أعد مصفوفة JSON فقط.
كل عنصر يجب أن يكون:
{
  "question": "<نص السؤال كاملاً بالعربي>",
  "questionType": "mcq" | "true_false" | "short_answer" | "essay" | "calculation",
  "options": ["أ) ...", "ب) ...", "ج) ...", "د) ..."] أو null للأسئلة المقالية,
  "correctAnswer": "<الإجابة الصحيحة أو null إذا لم تذكر في النص>",
  "explanation": "<الشرح إن وُجد أو null>",
  "topic": "<الموضوع إن وُجد>",
  "chapter": "<الفصل إن وُجد>",
  "difficulty": "easy" | "medium" | "hard" | null
}

قواعد:
- استخرج الأسئلة الفعلية فقط. تجاهل العناوين والتعليمات وأرقام الصفحات.
- للاختيار من متعدد، ضع الخيارات في "options".
- للصواب/الخطأ، ضع ["صواب", "خطأ"] في "options".
- إذا ذُكرت الإجابة في النص، ضعها في "correctAnswer"، وإلا null.
- أجب بمصفوفة JSON فقط، بدون أي نص إضافي أو markdown.
- إذا لم توجد أسئلة، أجب بـ: []

عنوان الامتحان: ${examTitle}

نص الامتحان:
${compressed}`;
}

// ─── Retry prompt (aggressive) ────────────────────────────────────────────────
// Used when first-pass extraction returns [] for a chunk that contains Arabic
// words — OCR artifacts (dots mixed into text, broken spacing) may have confused
// the main prompt. This prompt is more tolerant of imperfect OCR formatting.
function buildRetryPrompt(chunkText: string, examTitle: string): string {
  const compressed = compressFillerDots(chunkText);
  return `أنت نظام متخصص في استخراج الأسئلة الامتحانية من نصوص OCR العربية.

النص التالي مُستخرج بالـ OCR وقد يحتوي على نقاط أو مسافات إضافية بين الكلمات.
استخرج كل سؤال موجود في النص بغض النظر عن جودة التنسيق.

ابحث عن أي من الأنماط التالية وعدّها أسئلة:
- أرقام عربية أو هندية + نص (١- ... أو 1. ...)
- كلمات تدل على سؤال: ما، اشرح، اذكر، عرّف، قارن، أكمل، ضع، اختر، بيّن، وضّح، احسب
- جمل استفهامية تنتهي بـ ؟
- اختيار من متعدد: أ/ ب/ ج/ د/ أو (أ) (ب) أو A B C D
- جداول مقارنة تطلب ملء خانات

أعد مصفوفة JSON فقط. كل عنصر:
{
  "question": "<نص السؤال كما ورد>",
  "questionType": "mcq" | "true_false" | "short_answer" | "essay" | "calculation",
  "options": ["أ) ...", "ب) ...", "ج) ...", "د) ..."] أو null,
  "correctAnswer": null,
  "explanation": null,
  "topic": null,
  "chapter": null,
  "difficulty": null
}

إذا لم توجد أسئلة على الإطلاق بعد الفحص الدقيق، أجب بـ: []

عنوان الامتحان: ${examTitle}

النص:
${compressed}`;
}

// ─── Response parser ──────────────────────────────────────────────────────────

interface ParsedQuestion {
  question:      string;
  questionType:  string;
  options:       string[] | null;
  correctAnswer: string | null;
  explanation:   string | null;
  topic:         string | null;
  chapter:       string | null;
  difficulty:    string | null;
}

function parseResponse(raw: string): ParsedQuestion[] {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    const parsed = JSON.parse(cleaned) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (q): q is ParsedQuestion =>
        typeof q === 'object' &&
        q !== null &&
        typeof (q as Record<string, unknown>).question === 'string' &&
        (q as Record<string, unknown>).question !== ''
    );
  } catch {
    return [];
  }
}

// ─── Deduplication ────────────────────────────────────────────────────────────

function deduplicateQuestions(questions: ParsedQuestion[]): ParsedQuestion[] {
  const seen = new Set<string>();
  return questions.filter((q) => {
    // Normalize: lowercase + strip whitespace for comparison
    const key = q.question.replace(/\s+/g, ' ').trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── Trigger (fire-and-forget, called from curriculumQueue) ──────────────────

/**
 * Trigger question extraction for a finished exam document.
 * Designed to be called fire-and-forget: errors are logged, never thrown.
 */
export async function triggerQuestionExtraction(docId: string): Promise<void> {
  const examId = examIdFromDocId(docId);

  try {
    const doc = getDocMeta(docId);
    if (!doc) {
      logger.warn({ docId }, 'triggerQuestionExtraction: doc not found in index, skipping');
      return;
    }

    if (doc.docType !== 'exam') {
      return;
    }

    // Skip if already extracted
    const already = await examStore.hasQuestions(examId);
    if (already) {
      logger.info({ docId, examId }, 'triggerQuestionExtraction: already extracted, skipping');
      return;
    }

    const chunks = loadChunks(docId);
    if (chunks.length === 0) {
      logger.warn({ docId }, 'triggerQuestionExtraction: no chunks found, skipping');
      return;
    }

    const examTitle = doc.bookTitle ?? doc.filename.replace(/\.pdf$/i, '');
    const visibility = doc.visibility ?? 'private';
    const ownerId   = (visibility === 'public') ? null : (doc.ownerId ?? null);

    // ── 3. upsertExamRecord(status:'extracting') ─────────────────────────────
    await examStore.upsertExamRecord({
      examId,
      curriculumDocId:  docId,
      title:            examTitle,
      bookTitle:        doc.bookTitle ?? null,
      subject:          doc.subject,
      grade:            doc.grade,
      country:          doc.country,
      track:            doc.track ?? '',
      year:             null,
      examType:         'final',
      organization:     null,
      ownerId,
      visibility,
      questionCount:    0,
      extractionStatus: 'extracting',
      extractionError:  null,
      extractedAt:      null,
    });

    logger.info(
      { docId, examId, chunks: chunks.length, title: examTitle },
      'triggerQuestionExtraction: starting extraction'
    );

    // ── 4. Batch chunks → Gemini → JSON ─────────────────────────────────────
    const allParsed: ParsedQuestion[] = [];

    // Diagnostic tracking — written to exam_records at the end of extraction.
    let totalExtractionAttempts = 0;
    const chunkDiagnostics: Array<{
      chunkIndex: number;
      chars: number;
      arabicWords: number;
      questionPatterns: number;
      extracted: number;
      retried: boolean;
    }> = [];

    for (const chunk of chunks) {
      if (chunk.content.trim().length < 80) continue;

      // Skip chunks whose content is essentially all fill-in-blank dots with no
      // question text (e.g. scanned exam answer sheets). Strip sequences of 2+
      // dots and whitespace — if fewer than 30 meaningful chars remain, the chunk
      // has no extractable questions and sending it to Gemini wastes a call.
      const meaningful = chunk.content.replace(/\.{2,}/g, '').replace(/\s+/g, '').trim();
      if (meaningful.length < 30) {
        logger.info(
          { docId, chunkIndex: chunk.chunkIndex, meaningfulChars: meaningful.length },
          'triggerQuestionExtraction: skipping dot-only chunk (no question content)'
        );
        continue;
      }

      // ── Question pattern detection (diagnostic, non-destructive) ────────────
      // Runs before Gemini to log structural signals in the chunk.
      // Helps diagnose why a chunk may return 0 questions after extraction.
      const patternCheck      = detectQuestionPatterns(chunk.content);
      const arabicWordsInChunk = (chunk.content.match(/[\u0600-\u06FF\u0750-\u077F]{2,}/g) || []).length;
      totalExtractionAttempts++;

      logger.debug(
        {
          docId,
          chunkIndex:      chunk.chunkIndex,
          chars:           chunk.content.length,
          arabicWords:     arabicWordsInChunk,
          questionPatterns: patternCheck.count,
          hasNumbered:     patternCheck.hasNumberedItems,
          hasQWords:       patternCheck.hasQuestionWords,
          hasMcq:          patternCheck.hasMcqOptions,
        },
        'triggerQuestionExtraction: pattern pre-check'
      );

      try {
        const raw    = await callGemini(buildPrompt(chunk.content, examTitle));
        let parsed   = parseResponse(raw);
        let retried  = false;

        // ── Phase 3 hardening: retry if first pass returned [] but chunk has
        // Arabic content. OCR artifacts (dots mixed into text, broken spacing)
        // can confuse the main prompt even when questions are present.
        // Also force retry when question patterns were detected (structural signal).
        if (parsed.length === 0) {
          const shouldRetry = arabicWordsInChunk >= 10 || patternCheck.count >= 2;
          if (shouldRetry) {
            logger.info(
              { docId, chunkIndex: chunk.chunkIndex, arabicWords: arabicWordsInChunk, patterns: patternCheck.count },
              'triggerQuestionExtraction: first pass returned [], retrying with aggressive prompt'
            );
            retried = true;
            try {
              const rawRetry    = await callGemini(buildRetryPrompt(chunk.content, examTitle));
              const parsedRetry = parseResponse(rawRetry);
              if (parsedRetry.length > 0) {
                parsed = parsedRetry;
                logger.info(
                  { docId, chunkIndex: chunk.chunkIndex, extracted: parsedRetry.length },
                  'triggerQuestionExtraction: retry extraction succeeded'
                );
              }
            } catch (retryErr) {
              logger.warn(
                { docId, chunkIndex: chunk.chunkIndex, err: String(retryErr) },
                'triggerQuestionExtraction: retry failed'
              );
            }
          }
        }

        allParsed.push(...parsed);

        chunkDiagnostics.push({
          chunkIndex:       chunk.chunkIndex,
          chars:            chunk.content.length,
          arabicWords:      arabicWordsInChunk,
          questionPatterns: patternCheck.count,
          extracted:        parsed.length,
          retried,
        });

        logger.debug(
          { docId, chunkIndex: chunk.chunkIndex, extracted: parsed.length, retried },
          'triggerQuestionExtraction: chunk done'
        );
      } catch (err) {
        // Daily quota exhausted — propagate immediately, stop all extraction
        if (err instanceof DailyQuotaExhaustedError) throw err;
        logger.warn(
          { docId, chunkIndex: chunk.chunkIndex, err: String(err) },
          'triggerQuestionExtraction: chunk skipped — Gemini error'
        );
      }
    }

    // ── 5-6. Validate + deduplicate ──────────────────────────────────────────
    const deduped = deduplicateQuestions(allParsed);

    // ── Aggregate diagnostics ─────────────────────────────────────────────────
    // Compute OCR quality score from the combined chunk text (post-OCR output).
    const allChunkText   = chunks.map((c) => c.content).join('\n');
    const ocrQual        = analyzeOcrText(allChunkText);
    const ocrQualityScore = Math.round(ocrQual.score);

    // Build a human-readable failure reason when 0 questions are extracted.
    const failureReason = deduped.length === 0
      ? `Extracted 0 questions from ${chunks.length} chunk(s). ` +
        `OCR quality score: ${ocrQualityScore}/100. ` +
        `Arabic words: ${ocrQual.arabicWordCount}. ` +
        `Pattern signals: ${chunkDiagnostics.reduce((s, c) => s + c.questionPatterns, 0)} across ${totalExtractionAttempts} chunk(s) attempted.`
      : null;

    if (failureReason) {
      logger.warn({ docId, examId, failureReason, ocrQualityScore }, 'triggerQuestionExtraction: zero questions extracted');
    }

    // ── 7. saveQuestions ──────────────────────────────────────────────────────
    const toInsert: InsertExamQuestion[] = deduped.map((q, idx) => ({
      id:               uuidv4(),
      examId,
      question:         q.question,
      questionType:     q.questionType ?? 'short_answer',
      options:          q.options ?? null,
      correctAnswer:    q.correctAnswer ?? null,
      explanation:      q.explanation ?? null,
      topic:            q.topic ?? null,
      chapter:          q.chapter ?? null,
      subject:          doc.subject,
      grade:            doc.grade,
      country:          doc.country,
      year:             null,
      examType:         'final',
      difficulty:       q.difficulty ?? null,
      organization:     null,
      sourceExamId:     examId,
      sourceExamTitle:  examTitle,
      questionOrder:    idx + 1,
    }));

    await examStore.saveQuestions(toInsert);

    // ── 8. upsertExamRecord(status:'done') ────────────────────────────────────
    await examStore.upsertExamRecord({
      examId,
      curriculumDocId:   docId,
      title:             examTitle,
      bookTitle:         doc.bookTitle ?? null,
      subject:           doc.subject,
      grade:             doc.grade,
      country:           doc.country,
      track:             doc.track ?? '',
      year:              null,
      examType:          'final',
      organization:      null,
      ownerId,
      visibility,
      questionCount:     toInsert.length,
      extractionStatus:  'done',
      extractionError:   null,
      extractedAt:       new Date(),
      // Diagnostic fields (nullable — written once per extraction run)
      ocrQualityScore,
      extractionAttempts: totalExtractionAttempts,
      failureReason,
      ocrDiagnostics: {
        ocrScore:      { score: ocrQualityScore, arabicWords: ocrQual.arabicWordCount, uniqueWordRatio: ocrQual.uniqueWordRatio },
        chunkCount:    chunks.length,
        chunksAttempted: totalExtractionAttempts,
        chunks:        chunkDiagnostics,
      },
    });

    logger.info(
      { docId, examId, totalQuestions: toInsert.length },
      'triggerQuestionExtraction: done'
    );

  } catch (err) {
    // Daily quota: re-throw so autoRecoverPendingExams can stop processing
    if (err instanceof DailyQuotaExhaustedError) {
      // Mark this exam as pending (not error) so it retries tomorrow
      try {
        const existing = await examStore.getExamRecord(examId);
        if (existing && existing.extractionStatus !== 'done') {
          await examStore.upsertExamRecord({
            ...existing,
            extractionStatus: 'pending',
            extractionError:  'Daily Gemini quota exhausted — will retry on next server restart',
          });
        }
      } catch { /* ignore */ }
      throw err;
    }

    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ docId, examId, err: msg }, 'triggerQuestionExtraction: failed');

    // Mark as error (best-effort)
    try {
      const doc = getDocMeta(docId);
      const existing = await examStore.getExamRecord(examId);
      if (existing) {
        await examStore.upsertExamRecord({
          ...existing,
          extractionStatus: 'error',
          extractionError:  msg,
        });
      }
    } catch { /* ignore */ }
  }
}
