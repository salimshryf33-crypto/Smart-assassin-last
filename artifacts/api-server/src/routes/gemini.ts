import { Router } from 'express';
import * as cache from '../services/cacheService';

const router = Router();

const GEMINI_BASE = 'https://generativelanguage.googleapis.com';

function getApiKey(): string | null {
  return process.env.GEMINI_API_KEY ?? null;
}

router.post('/generate', async (req, res) => {
  const apiKey = getApiKey();
  if (!apiKey) {
    res.status(503).json({ error: 'Gemini API key not configured on server' });
    return;
  }

  const { model = 'gemini-1.5-flash-latest', ...body } = req.body as {
    model?: string;
    [key: string]: unknown;
  };

  // ── Cache lookup (body-content hash = deterministic per conversation state) ──
  const bodyHash  = cache.hashPart({ model, ...body });
  const cacheKey  = cache.chatKey(bodyHash);
  const cached    = await cache.get<unknown>(cacheKey, true);
  if (cached !== null) {
    res.setHeader('X-Cache', 'HIT');
    res.json(cached);
    return;
  }

  try {
    const upstream = await fetch(
      `${GEMINI_BASE}/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );

    const data = await upstream.json();

    if (!upstream.ok) {
      res.status(upstream.status).json(data);
      return;
    }

    // Store in cache (fire-and-forget — never delays response)
    cache.set(cacheKey, data, cache.TTL.CHAT).catch(() => undefined);

    res.setHeader('X-Cache', 'MISS');
    res.json(data);
  } catch (err) {
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
