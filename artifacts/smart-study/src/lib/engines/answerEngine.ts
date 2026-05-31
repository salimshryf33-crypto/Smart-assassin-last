/**
 * ANSWER ENGINE — Strict RAG-Only Answering
 *
 * Responsibility:
 *   Given a student question + curriculum context, retrieve relevant curriculum
 *   chunks via RAG and produce a grounded answer using Gemini.
 *
 * Rules:
 *   - NEVER answers without first attempting RAG retrieval
 *   - NEVER generates flashcards or detects weaknesses
 *   - NEVER calls other engines
 *   - Throws on missing API key (caller handles gracefully)
 */

import { searchCurriculum, formatCurriculumContext } from '../../utils/curriculumSearch';
import { buildSystemPrompt } from '../../utils/ai';
import type { ConversationMessage, CurriculumContext } from '../../utils/ai';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AnswerRequest {
  message: string;
  history: ConversationMessage[];
  curriculum: CurriculumContext;
}

export interface AnswerResult {
  text: string;
  ragChunksFound: number;
  retrievedContext: string | null;
  modelUsed: string;
}

export type AnswerEngineError =
  | { code: 'NO_API_KEY' }
  | { code: 'QUOTA_EXCEEDED' }
  | { code: 'EMPTY_RESPONSE' }
  | { code: 'NETWORK_ERROR'; detail: string };

// ─── Internal Helpers ─────────────────────────────────────────────────────────

const GEMINI_BASE = 'https://generativelanguage.googleapis.com';
const DEFAULT_MODEL = 'gemini-1.5-flash-latest';

function resolveApiKey(): string | null {
  return (
    (typeof import.meta !== 'undefined' && import.meta.env?.VITE_GEMINI_API_KEY) ||
    (typeof localStorage !== 'undefined' && localStorage.getItem('sage_gemini_api_key')) ||
    null
  );
}

let _cachedModel: string | null = null;

async function resolveModel(apiKey: string): Promise<string> {
  if (_cachedModel) return _cachedModel;
  try {
    const res = await fetch(`${GEMINI_BASE}/v1beta/models?key=${apiKey}`);
    if (res.ok) {
      const data = await res.json();
      const models: Array<{ name: string; supportedGenerationMethods?: string[] }> =
        data.models ?? [];
      const match = models.find(
        (m) =>
          Array.isArray(m.supportedGenerationMethods) &&
          m.supportedGenerationMethods.includes('generateContent') &&
          !m.name.includes('vision') &&
          !m.name.includes('embedding') &&
          !m.name.includes('aqa')
      );
      if (match) {
        _cachedModel = match.name.replace(/^models\//, '');
        return _cachedModel;
      }
    }
  } catch {
    /* fall through to default */
  }
  _cachedModel = DEFAULT_MODEL;
  return _cachedModel;
}

/** Clear cached model — call if the model returns a 404 */
export function resetModelCache(): void {
  _cachedModel = null;
}

// ─── RAG Retrieval ────────────────────────────────────────────────────────────

/**
 * Retrieve grounding context from the curriculum index.
 * Returns null if the curriculum is incomplete or retrieval fails.
 */
async function retrieveContext(
  curriculum: CurriculumContext,
  query: string
): Promise<{ chunks: number; formatted: string } | null> {
  if (!curriculum.country || !curriculum.level || !curriculum.subject) return null;
  try {
    const chunks = await searchCurriculum(
      curriculum.country,
      curriculum.level,
      curriculum.subject,
      query,
      5
    );
    if (!chunks.length) return null;
    return { chunks: chunks.length, formatted: formatCurriculumContext(chunks) };
  } catch {
    return null;
  }
}

// ─── Gemini Call ──────────────────────────────────────────────────────────────

async function callGemini(
  apiKey: string,
  modelId: string,
  systemPrompt: string,
  history: ConversationMessage[],
  userMessage: string
): Promise<string> {
  const contents: ConversationMessage[] = [
    ...history,
    { role: 'user', parts: [{ text: userMessage }] },
  ];

  // Attempt 1 — system_instruction field (v1beta)
  const attempt1 = async () => {
    const url = `${GEMINI_BASE}/v1beta/models/${modelId}:generateContent?key=${apiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents,
        generationConfig: { maxOutputTokens: 1024, temperature: 0.7 },
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      const msg: string = data?.error?.message ?? `HTTP ${res.status}`;
      if (
        res.status === 429 ||
        msg.toLowerCase().includes('quota') ||
        msg.toLowerCase().includes('resource_exhausted')
      ) {
        throw Object.assign(new Error(msg), { code: 'QUOTA_EXCEEDED' });
      }
      if (msg.toLowerCase().includes('not found')) resetModelCache();
      throw new Error(msg);
    }
    const text: string = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    if (!text) throw new Error('EMPTY_RESPONSE');
    return text;
  };

  // Attempt 2 — prepend system as first user turn (fallback for older models)
  const attempt2 = async () => {
    const url = `${GEMINI_BASE}/v1beta/models/${modelId}:generateContent?key=${apiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          { role: 'user', parts: [{ text: systemPrompt }] },
          {
            role: 'model',
            parts: [{ text: 'مفهوم. أنا Sage، مدرسك الخاص. كيف يمكنني مساعدتك؟' }],
          },
          ...history,
          { role: 'user', parts: [{ text: userMessage }] },
        ],
        generationConfig: { maxOutputTokens: 1024, temperature: 0.7 },
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      const msg: string = data?.error?.message ?? `HTTP ${res.status}`;
      throw new Error(msg);
    }
    const text: string = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    if (!text) throw new Error('EMPTY_RESPONSE');
    return text;
  };

  try {
    return await attempt1();
  } catch (err: unknown) {
    if (err instanceof Error && (err as { code?: string }).code === 'QUOTA_EXCEEDED') throw err;
    return await attempt2();
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Answer a student question using strict RAG grounding.
 *
 * @throws AnswerEngineError codes as Error.message
 */
export async function answerQuestion(req: AnswerRequest): Promise<AnswerResult> {
  const apiKey = resolveApiKey();
  if (!apiKey) throw Object.assign(new Error('NO_API_KEY'), { code: 'NO_API_KEY' });

  const [modelId, ragResult] = await Promise.all([
    resolveModel(apiKey),
    retrieveContext(req.curriculum, req.message),
  ]);

  const systemPrompt = buildSystemPrompt(req.curriculum, ragResult?.formatted ?? undefined);

  const text = await callGemini(
    apiKey,
    modelId,
    systemPrompt,
    req.history,
    req.message
  );

  return {
    text,
    ragChunksFound: ragResult?.chunks ?? 0,
    retrievedContext: ragResult?.formatted ?? null,
    modelUsed: modelId,
  };
}
