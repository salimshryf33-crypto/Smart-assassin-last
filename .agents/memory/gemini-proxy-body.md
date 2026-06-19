---
name: Gemini Proxy Body Limits
description: callGemini in answerEngine.ts must not call res.json() before checking res.ok; express.json() needs a 10mb limit for large RAG contexts.
---

## The Rule
In `callGemini` (answerEngine.ts), always read `await res.text()` first, then manually `JSON.parse(raw)`. Never call `await res.json()` before the `res.ok` check.

**Why:** When Express hits an error (413 Payload Too Large, 502, unhandled exception), its default error handler returns an HTML page (`<!DOCTYPE html>…`). If `res.json()` is called on that HTML response, it throws `"Failed to execute 'json' on 'Response': Unexpected token '<'"` — which is the chat error the user sees. Using `res.text()` first lets us gracefully handle any content type.

**How to apply:** Any new Gemini proxy fetch call should follow this pattern:
```ts
const raw = await res.text();
if (!res.ok) {
  let msg = `HTTP ${res.status}`;
  try { msg = JSON.parse(raw)?.error?.message ?? msg; } catch { /* HTML or plain text */ }
  throw new Error(msg);
}
const data = JSON.parse(raw);
```

## The Body Size Limit
`app.ts` uses `express.json({ limit: '10mb' })`. The default 100kb is easily exceeded by RAG context: 10 chunks × Arabic textbook content (≈ 2–4kb UTF-8 each) can push the POST body over 100kb. Express returns a 413 HTML page in development mode, triggering the json-parse error above.

**How to apply:** Keep the 10mb limit in `app.ts`. If adding new POST routes that accept large payloads (e.g., bulk uploads), they are already covered.
