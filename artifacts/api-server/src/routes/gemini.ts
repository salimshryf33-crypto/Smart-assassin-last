import { Router } from 'express';

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
