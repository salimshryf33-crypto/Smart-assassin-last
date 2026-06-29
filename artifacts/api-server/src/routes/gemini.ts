import { Router } from 'express';
import * as cache from '../services/cacheService';

const router = Router();

const GEMINI_BASE = 'https://generativelanguage.googleapis.com';

/**
 * Context Mode validation — backend source of truth.
 * Must stay in sync with contextMode.ts on the frontend.
 * Backend validates all incoming modes; unknown modes are rejected with 400.
 */
const VALID_CONTEXT_MODES = new Set([
  'BOOK_MODE',
  'NOTES_MODE',
  'EXAM_MODE',
  'QUIZ_MODE',
]);

function getApiKey(): string | null {
  return process.env.GEMINI_API_KEY ?? null;
}

router.post('/generate', async (req, res) => {
  const apiKey = getApiKey();
  if (!apiKey) {
    res.status(503).json({ error: 'Gemini API key not configured on server' });
    return;
  }

  const { model = 'gemini-1.5-flash-latest', mode, ...body } = req.body as {
    model?: string;
    mode?: string;
    [key: string]: unknown;
  };

  // ── Mode validation ───────────────────────────────────────────────────────
  // If a mode is provided, it must be a known registered ContextMode.
  // Requests without a mode are accepted for backward compatibility (legacy calls).
  if (mode !== undefined && !VALID_CONTEXT_MODES.has(mode)) {
    res.status(400).json({ error: `Unknown context mode: "${mode}". Valid modes: ${[...VALID_CONTEXT_MODES].join(', ')}` });
    return;
  }
  // mode is stripped from body — never forwarded to Gemini API.
  // ─────────────────────────────────────────────────────────────────────────

  // ── Cache + Single-Flight (stampede protection) ───────────────────────────
  // getOrCompute ensures only ONE Gemini call runs for identical concurrent requests.
  // Errors are NOT cached — they propagate to the typed catch block below.
  const bodyHash = cache.hashPart({ model, ...body });
  const cacheKey = cache.chatKey(bodyHash);

  interface UpstreamError { __upstreamError: true; status: number; data: unknown; }

  try {
    const { value: data, fromCache } = await cache.getOrCompute<unknown>(
      cacheKey,
      async () => {
        const upstream = await fetch(
          `${GEMINI_BASE}/v1beta/models/${model}:generateContent?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }
        );
        const json = await upstream.json() as unknown;

        if (!upstream.ok) {
          // Throw a typed error so getOrCompute skips caching this response.
          const err: UpstreamError = {
            __upstreamError: true,
            status: upstream.status,
            data: json,
          };
          throw err;
        }

        return json;
      },
      cache.TTL.CHAT,
      true // isGemini — increments savedGeminiCalls on cache/flight hit
    );

    res.setHeader('X-Cache', fromCache ? 'HIT' : 'MISS');
    res.json(data);
  } catch (err: unknown) {
    const typed = err as Partial<UpstreamError>;
    if (typed.__upstreamError) {
      res.status(typed.status!).json(typed.data);
      return;
    }
    req.log.error({ err }, 'Gemini proxy error');
    res.status(502).json({ error: 'Failed to reach Gemini API' });
  }
});

router.get('/models', async (req, res) => {
  const apiKey = getApiKey();
  if (!apiKey) {
    res.status(503).json({ error: 'Gemini API key not configured on server' });
    return;
  }

  try {
    const upstream = await fetch(
      `${GEMINI_BASE}/v1beta/models?key=${apiKey}`
    );
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    req.log.error({ err }, 'Gemini models proxy error');
    res.status(502).json({ error: 'Failed to reach Gemini API' });
  }
});

export default router;
