/**
 * questionExtractor — AI-powered question extraction from exam chunks.
 *
 * Data flow:
 *   1. getDocMeta(docId)   → curriculumStorage
 *   2. loadChunks(docId)   → curriculumStorage
 *   3. upsertExamRecord(status:'extracting')
 *   4. Phase 7: Cache check per chunk → skip Gemini if already extracted
 *   5. Phase 1+2: Standard Gemini pass → coverage check → aggressive retry if LOW
 *   6. Phase 3: Failed-chunk recovery (3rd targeted pass, only suspicious chunks)
 *   7. Phase 4: Normalize questions (fix OCR artifacts, merge split lines)
 *   8. Phase 5: Enhanced dedup (exact + near-match Jaccard)
 *   9. Phase 1: Whole-exam coverage analysis → LOW_EXTRACTION_COVERAGE flag
 *  10. Phase 6: Extraction score (0-100) stored in ocrDiagnostics
 *  11. saveQuestions + upsertExamRecord(status:'done')
 *
 * ARCHITECTURE RULE: never touches PostgreSQL directly — all DB writes via examStore.
 */
import { v4 as uuidv4 } from 'uuid';
import { getDocMeta, loadChunks } from './curriculumStorage';
import { examStore, examIdFromDocId } from './examStore';
import { logger } from './logger';
import { detectQuestionPatterns, analyzeOcrText } from './ocrQualityAnalyzer';
import {
  analyzeChunkCoverage,
  analyzeCoverage,
  computeExtractionScore,
  type ChunkDiagEntry,
} from './coverageAnalyzer';
import { normalizeAll, deduplicateEnhanced } from './questionNormalizer';
import { getCachedExtraction, setCachedExtraction, getExtractionCacheStats } from './extractionCache';
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

// ─── Prompts ──────────────────────────────────────────────────────────────────

/** Compress long dot/underscore runs (fill-blank markers) to save tokens. */
function compressFillerDots(text: string): string {
  return text.replace(/\.{4,}/g, '....').replace(/_{4,}/g, '____');
}

/** Pass 1 — Standard extraction prompt. */
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

/** Pass 2 — Aggressive extraction for OCR-heavy text (retry on LOW_EXTRACTION_COVERAGE). */
function buildRetryPrompt(chunkText: string, examTitle: string): string {
  const compressed = compressFillerDots(chunkText);
  return `أنت نظام متخصص في استخراج الأسئلة الامتحانية من نصوص OCR العربية.

النص التالي مُستخرج بالـ OCR وقد يحتوي على نقاط أو مسافات إضافية بين الكلمات.
استخرج كل سؤال موجود في النص بغض النظر عن جودة التنسيق.

ابحث عن أي من الأنماط التالية وعدّها أسئلة:
- أرقام عربية أو هندية + نص (١- ... أو 1. ...)
- كلمات تدل على سؤال: ما، اشرح، اذكر، عرّف، قارن، أكمل، ضع، اختر، بيّن، وضّح، احسب، علّل، فسّر، ما المقصود، ناقش، برهن، أثبت، استنتج
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

/**
 * Pass 3 — Phase 3 targeted recovery prompt.
 * Used only for chunks that produced 0 questions in both passes 1 and 2
 * but contain credible question-pattern signals. Instructs Gemini to treat
 * every numbered or indented item as a potential question.
 */
function buildRecoveryPrompt(chunkText: string, examTitle: string): string {
  const compressed = compressFillerDots(chunkText);
  return `أنت خبير في استخراج الأسئلة من نصوص ممسوحة ضوئياً بجودة منخفضة.

هذا النص استعصى على المعالجة المعتادة. المطلوب:
1. تعامل مع كل جملة تحتوي على فعل أمر، أو رقم في بداية السطر، أو علامة استفهام كسؤال مستقل.
2. لا تستبعد أي عنصر مهما بدا ناقصاً — أعد ما تجده.
3. أعد المصفوفة حتى لو كانت الأسئلة غير مكتملة.

مصفوفة JSON فقط بنفس الصيغة السابقة.
إذا لم يكن هناك شيء مطلقاً، أجب بـ: []

عنوان: ${examTitle}
النص:
${compressed}`;
}

// ─── Response parser ──────────────────────────────────────────────────────────

export interface ParsedQuestion {
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

// ─── Extended chunk diagnostics ───────────────────────────────────────────────

interface ChunkDiag extends ChunkDiagEntry {
  chars: number;
  retried: boolean;
  cached?: boolean;
  recovered?: boolean;
  coverageFlag?: string;
  pass?: number;          // highest pass that produced results (1/2/3)
}

// ─── Trigger (fire-and-forget, called from curriculumQueue) ──────────────────

/**
 * Trigger question extraction for a finished exam document.
 * Designed to be called fire-and-forget — errors are logged, never thrown.
 * DailyQuotaExhaustedError is re-thrown so callers can stop the batch.
 */
export async function triggerQuestionExtraction(docId: string): Promise<void> {
  const examId = examIdFromDocId(docId);

  try {
    const doc = getDocMeta(docId);
    if (!doc) {
      logger.warn({ docId }, 'triggerQuestionExtraction: doc not found in index, skipping');
      return;
    }

    if (doc.docType !== 'exam') return;

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

    // ── Main per-chunk extraction loop ────────────────────────────────────────
    const allParsed: ParsedQuestion[] = [];
    let totalExtractionAttempts = 0;
    const chunkDiags: ChunkDiag[] = [];

    for (const chunk of chunks) {
      if (chunk.content.trim().length < 80) continue;

      const meaningful = chunk.content.replace(/\.{2,}/g, '').replace(/\s+/g, '').trim();
      if (meaningful.length < 30) {
        logger.info(
          { docId, chunkIndex: chunk.chunkIndex, meaningfulChars: meaningful.length },
          'triggerQuestionExtraction: skipping dot-only chunk'
        );
        continue;
      }

      const patternCheck      = detectQuestionPatterns(chunk.content);
      const arabicWordsInChunk = (chunk.content.match(/[\u0600-\u06FF\u0750-\u077F]{2,}/g) || []).length;
      totalExtractionAttempts++;

      // ── Phase 7: Cache check ────────────────────────────────────────────────
      const cached = getCachedExtraction<ParsedQuestion>(chunk.content);
      if (cached !== null) {
        allParsed.push(...cached);
        chunkDiags.push({
          chunkIndex:       chunk.chunkIndex,
          chars:            chunk.content.length,
          arabicWords:      arabicWordsInChunk,
          questionPatterns: patternCheck.count,
          extracted:        cached.length,
          retried:          false,
          cached:           true,
          coverageFlag:     'OK',
          pass:             0,
        });
        logger.debug(
          { docId, chunkIndex: chunk.chunkIndex, cached: cached.length },
          'triggerQuestionExtraction: cache hit'
        );
        continue;
      }

      logger.debug(
        {
          docId,
          chunkIndex:       chunk.chunkIndex,
          chars:            chunk.content.length,
          arabicWords:      arabicWordsInChunk,
          questionPatterns: patternCheck.count,
          hasNumbered:      patternCheck.hasNumberedItems,
          hasQWords:        patternCheck.hasQuestionWords,
          hasMcq:           patternCheck.hasMcqOptions,
        },
        'triggerQuestionExtraction: pattern pre-check'
      );

      try {
        // ── Pass 1: Standard extraction ───────────────────────────────────────
        const raw    = await callGemini(buildPrompt(chunk.content, examTitle));
        let parsed   = parseResponse(raw);
        let retried  = false;
        let pass     = 1;

        // ── Phase 1+2: Coverage check → trigger Pass 2 ───────────────────────
        const chunkCov = analyzeChunkCoverage(arabicWordsInChunk, patternCheck.count, parsed.length);
        const needsPass2 =
          chunkCov.flag === 'LOW_EXTRACTION_COVERAGE' &&
          (arabicWordsInChunk >= 10 || patternCheck.count >= 1);

        if (needsPass2) {
          logger.info(
            {
              docId, chunkIndex: chunk.chunkIndex,
              arabicWords: arabicWordsInChunk, patterns: patternCheck.count,
              pass1Count: parsed.length, coverageFlag: chunkCov.flag,
            },
            'triggerQuestionExtraction: Pass 2 — aggressive extraction (LOW_EXTRACTION_COVERAGE)'
          );
          retried = true;
          try {
            const rawRetry    = await callGemini(buildRetryPrompt(chunk.content, examTitle));
            const parsedRetry = parseResponse(rawRetry);
            if (parsedRetry.length > parsed.length) {
              parsed = parsedRetry;
              pass   = 2;
              logger.info(
                { docId, chunkIndex: chunk.chunkIndex, extracted: parsedRetry.length },
                'triggerQuestionExtraction: Pass 2 succeeded'
              );
            }
          } catch (retryErr) {
            if (retryErr instanceof DailyQuotaExhaustedError) throw retryErr;
            logger.warn(
              { docId, chunkIndex: chunk.chunkIndex, err: String(retryErr) },
              'triggerQuestionExtraction: Pass 2 failed'
            );
          }
        }

        // ── Phase 7: Cache successful result ──────────────────────────────────
        if (parsed.length > 0) {
          setCachedExtraction(chunk.content, parsed);
        }

        allParsed.push(...parsed);
        chunkDiags.push({
          chunkIndex:       chunk.chunkIndex,
          chars:            chunk.content.length,
          arabicWords:      arabicWordsInChunk,
          questionPatterns: patternCheck.count,
          extracted:        parsed.length,
          retried,
          cached:           false,
          coverageFlag:     chunkCov.flag,
          pass,
        });

        logger.debug(
          { docId, chunkIndex: chunk.chunkIndex, extracted: parsed.length, pass, retried },
          'triggerQuestionExtraction: chunk done'
        );

      } catch (err) {
        if (err instanceof DailyQuotaExhaustedError) throw err;
        logger.warn(
          { docId, chunkIndex: chunk.chunkIndex, err: String(err) },
          'triggerQuestionExtraction: chunk skipped — Gemini error'
        );
        chunkDiags.push({
          chunkIndex: chunk.chunkIndex, chars: chunk.content.length,
          arabicWords: arabicWordsInChunk, questionPatterns: patternCheck.count,
          extracted: 0, retried: false, cached: false, coverageFlag: 'GEMINI_ERROR',
        });
      }
    }

    // ── Phase 3: Failed Chunk Recovery ───────────────────────────────────────
    // Re-run ONLY chunks with 0 questions + credible question signals.
    // This is a third targeted pass — never reprocesses the whole document.
    const failedSuspicious = chunks.filter(ch => {
      const diag = chunkDiags.find(d => d.chunkIndex === ch.chunkIndex);
      return (
        diag &&
        diag.extracted === 0 &&
        diag.questionPatterns >= 1 &&
        !diag.cached &&
        diag.coverageFlag !== 'GEMINI_ERROR'
      );
    });

    if (failedSuspicious.length > 0) {
      logger.info(
        { docId, failedChunks: failedSuspicious.length },
        'triggerQuestionExtraction: Phase 3 — targeted failed-chunk recovery'
      );

      for (const ch of failedSuspicious) {
        try {
          const rawRecovery    = await callGemini(buildRecoveryPrompt(ch.content, examTitle));
          const parsedRecovery = parseResponse(rawRecovery);

          if (parsedRecovery.length > 0) {
            allParsed.push(...parsedRecovery);
            setCachedExtraction(ch.content, parsedRecovery);

            const diag = chunkDiags.find(d => d.chunkIndex === ch.chunkIndex);
            if (diag) {
              diag.extracted  = parsedRecovery.length;
              diag.recovered  = true;
              diag.pass       = 3;
            }

            logger.info(
              { docId, chunkIndex: ch.chunkIndex, recovered: parsedRecovery.length },
              'triggerQuestionExtraction: Phase 3 — chunk recovered'
            );
          }
        } catch (err) {
          if (err instanceof DailyQuotaExhaustedError) throw err;
          logger.warn(
            { docId, chunkIndex: ch.chunkIndex, err: String(err) },
            'triggerQuestionExtraction: Phase 3 — recovery failed'
          );
        }
      }
    }

    // ── Phase 4: Normalize questions (fix OCR artifacts) ─────────────────────
    const normalized = normalizeAll(allParsed);

    // ── Phase 5: Enhanced deduplication (exact + near-match Jaccard) ─────────
    const { deduped, exactRemoved, nearRemoved } = deduplicateEnhanced(normalized);

    if (exactRemoved > 0 || nearRemoved > 0) {
      logger.info(
        { docId, exactRemoved, nearRemoved, before: allParsed.length, after: deduped.length },
        'triggerQuestionExtraction: deduplication complete'
      );
    }

    // ── Phase 1: Whole-exam coverage analysis ─────────────────────────────────
    const coverageReport = analyzeCoverage(chunkDiags, deduped.length);
    if (coverageReport.flag === 'LOW_EXTRACTION_COVERAGE') {
      logger.warn(
        { docId, examId, coverage: coverageReport },
        'triggerQuestionExtraction: LOW_EXTRACTION_COVERAGE — check suspicious chunks'
      );
    }

    // ── OCR quality + failure reason ──────────────────────────────────────────
    const allChunkText   = chunks.map((c) => c.content).join('\n');
    const ocrQual        = analyzeOcrText(allChunkText);
    const ocrQualityScore = Math.round(ocrQual.score);

    const failureReason = deduped.length === 0
      ? `Extracted 0 questions. Coverage: ${coverageReport.diagnosis} ` +
        `OCR score: ${ocrQualityScore}/100.`
      : null;

    if (failureReason) {
      logger.warn({ docId, examId, failureReason, ocrQualityScore }, 'triggerQuestionExtraction: zero questions extracted');
    }

    // ── Phase 6: Extraction score (0-100) ────────────────────────────────────
    const cacheStats = getExtractionCacheStats();
    const extractionScoreResult = computeExtractionScore({
      ocrQualityScore,
      coverageRatio:   coverageReport.coverageRatio,
      successfulChunks: chunkDiags.filter(c => c.extracted > 0).length,
      totalChunks:     chunkDiags.length,
      exactRemoved,
      nearRemoved,
      totalExtracted:  allParsed.length,
      recoveredChunks: chunkDiags.filter(c => c.recovered).length,
    });

    logger.info(
      { docId, examId, score: extractionScoreResult.total, grade: extractionScoreResult.grade },
      'triggerQuestionExtraction: extraction score'
    );

    // ── Save questions ────────────────────────────────────────────────────────
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

    await examStore.upsertExamRecord({
      examId,
      curriculumDocId:    docId,
      title:              examTitle,
      bookTitle:          doc.bookTitle ?? null,
      subject:            doc.subject,
      grade:              doc.grade,
      country:            doc.country,
      track:              doc.track ?? '',
      year:               null,
      examType:           'final',
      organization:       null,
      ownerId,
      visibility,
      questionCount:      toInsert.length,
      extractionStatus:   'done',
      extractionError:    null,
      extractedAt:        new Date(),
      ocrQualityScore,
      extractionAttempts: totalExtractionAttempts,
      failureReason,
      ocrDiagnostics: {
        // Phase 1: OCR + coverage
        ocrScore: {
          score:           ocrQualityScore,
          arabicWords:     ocrQual.arabicWordCount,
          uniqueWordRatio: ocrQual.uniqueWordRatio,
        },
        coverage: coverageReport,
        // Phase 6: Extraction score
        extractionScore: extractionScoreResult,
        // Phase 4+5: Normalization + dedup stats
        normalization: {
          rawExtracted:  allParsed.length,
          afterNorm:     normalized.length,
          exactRemoved,
          nearRemoved,
          finalCount:    deduped.length,
        },
        // Phase 7: Cache stats
        cache: cacheStats,
        // Chunk-level detail
        chunkCount:      chunks.length,
        chunksAttempted: totalExtractionAttempts,
        chunks:          chunkDiags,
      },
    });

    logger.info(
      { docId, examId, totalQuestions: toInsert.length, score: extractionScoreResult.total },
      'triggerQuestionExtraction: done'
    );

  } catch (err) {
    // Daily quota: re-throw so batch callers can stop
    if (err instanceof DailyQuotaExhaustedError) {
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
