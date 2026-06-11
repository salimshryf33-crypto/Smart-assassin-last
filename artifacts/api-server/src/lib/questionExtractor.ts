/**
 * questionExtractor — AI-powered question extraction from exam chunks.
 *
 * Takes the CurriculumChunk[] produced by the OCR pipeline for a docType='exam'
 * document and calls Gemini to parse each chunk into structured Q&A records.
 *
 * Architecture rule: this module does NOT touch PostgreSQL. It returns
 * InsertExamQuestion[] and lets the caller (curriculumQueue) persist via examStore.
 */
import type { CurriculumChunk } from './curriculumStorage';
import type { InsertExamQuestion } from '@workspace/db';
import { logger } from './logger';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com';

function getApiKey(): string | null {
  return process.env.GEMINI_API_KEY ?? null;
}

// ─── Gemini call ──────────────────────────────────────────────────────────────

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
  }>;
}

async function callGemini(prompt: string): Promise<string> {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');

  const res = await fetch(
    `${GEMINI_BASE}/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 2048, temperature: 0.1 },
      }),
    }
  );

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(`Gemini error ${res.status}: ${JSON.stringify(data)}`);
  }

  const data = (await res.json()) as GeminiResponse;
  return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}

// ─── Prompt builder ───────────────────────────────────────────────────────────

function buildExtractionPrompt(chunkText: string): string {
  return `You are an exam question extractor for Arabic educational content.

Extract ALL questions from the following exam text. For each question return a JSON array.
Each element must be:
{
  "questionText": "<full question text in Arabic>",
  "questionType": "mcq" | "short_answer" | "essay",
  "options": ["أ) ...", "ب) ...", "ج) ...", "د) ..."] or null,
  "answer": "<correct answer or null if unknown>"
}

Rules:
- Only extract actual exam questions. Ignore headers, instructions, and page numbers.
- For MCQ, populate "options" with the list of choices as written.
- For short_answer / essay, set "options" to null.
- If the correct answer is stated in the text, capture it in "answer". Otherwise null.
- Respond with ONLY the JSON array, no markdown fences, no explanation.
- If no questions found, respond with exactly: []

EXAM TEXT:
${chunkText}`;
}

// ─── Parsed question from AI response ────────────────────────────────────────

interface ParsedQuestion {
  questionText: string;
  questionType: 'mcq' | 'short_answer' | 'essay';
  options: string[] | null;
  answer: string | null;
}

function parseResponse(raw: string): ParsedQuestion[] {
  const text = raw.trim();
  // Strip markdown fences if Gemini added them despite instructions
  const cleaned = text
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
        typeof (q as Record<string, unknown>).questionText === 'string' &&
        (q as Record<string, unknown>).questionText.length > 0
    );
  } catch {
    return [];
  }
}

// ─── Main extractor ───────────────────────────────────────────────────────────

export interface ExtractionMeta {
  docId: string;
  ownerId: string | null;
  visibility: 'public' | 'private';
  country: string;
  grade: string;
  subject: string;
  track: string;
}

/**
 * Extract structured exam questions from a list of curriculum chunks.
 *
 * Processes chunks in series (no parallel Gemini calls) to stay within quota.
 * Skips chunks that are too short to contain questions (< 100 chars).
 *
 * @returns InsertExamQuestion[] — ready to pass to examStore.saveQuestions()
 */
export async function extractQuestionsFromChunks(
  chunks: CurriculumChunk[],
  meta: ExtractionMeta
): Promise<InsertExamQuestion[]> {
  const results: InsertExamQuestion[] = [];

  for (const chunk of chunks) {
    if (chunk.content.trim().length < 100) continue;

    try {
      const raw = await callGemini(buildExtractionPrompt(chunk.content));
      const parsed = parseResponse(raw);

      for (const q of parsed) {
        results.push({
          docId:           meta.docId,
          ownerId:         meta.ownerId,
          visibility:      meta.visibility,
          country:         meta.country,
          grade:           meta.grade,
          subject:         meta.subject,
          track:           meta.track,
          questionText:    q.questionText,
          questionType:    q.questionType,
          options:         q.options ?? null,
          answer:          q.answer ?? null,
          sourcePageRange: chunk.pageRange ?? null,
        });
      }

      logger.debug(
        { docId: meta.docId, chunkIndex: chunk.chunkIndex, extracted: parsed.length },
        'questionExtractor: chunk processed'
      );
    } catch (err) {
      logger.warn(
        { docId: meta.docId, chunkIndex: chunk.chunkIndex, err: String(err) },
        'questionExtractor: skipping chunk — Gemini error'
      );
    }
  }

  logger.info(
    { docId: meta.docId, totalQuestions: results.length, totalChunks: chunks.length },
    'questionExtractor: extraction complete'
  );

  return results;
}
