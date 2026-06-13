/**
 * Gemini gemini-embedding-2 service.
 *
 * Stores embeddings directly in the existing chunk JSON files.
 * Does NOT touch PostgreSQL, Firebase, OCR pipeline, or any other
 * sensitive system — only reads/writes chunk data via curriculumStorage.
 */
import { logger } from './logger';

// Use the latest available Gemini embedding model for this API key.
// Run `ListModels` to see all embedContent-capable models if this changes.
const EMBED_MODEL = 'gemini-embedding-2';
const EMBED_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:embedContent`;

function getApiKey(): string {
  const k = process.env['GEMINI_API_KEY'];
  if (!k) throw new Error('GEMINI_API_KEY not set');
  return k;
}

// ─── Core embedding call ──────────────────────────────────────────────────────

export async function getEmbedding(text: string): Promise<number[]> {
  const url = `${EMBED_URL}?key=${getApiKey()}`;
  // NOTE: the model is specified in the URL — do NOT include it in the body.
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: { parts: [{ text: text.slice(0, 8000) }] },
    }),
  });

  if (!res.ok) {
    const msg = await res.text().catch(() => '');
    throw new Error(`Embedding API ${res.status}: ${msg.slice(0, 200)}`);
  }

  const data = (await res.json()) as { embedding: { values: number[] } };
  return data.embedding.values;
}

// ─── Cosine similarity ────────────────────────────────────────────────────────

export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

// ─── Batch generator with exponential backoff ─────────────────────────────────
//
// gemini-embedding-2 free-tier ≈ 15 RPM (4 s/req needed to stay safe).
// On HTTP 429 we apply exponential backoff: 30 s, 60 s, 120 s, 240 s.
// After MAX_RETRIES the chunk is skipped (logged as warning) and retried
// on the next server startup.

const DELAY_MS      = 4000;   // baseline gap between requests (~15 RPM)
const BATCH_SIZE    = 5;      // chunks per mini-batch
const BETWEEN_BATCH = 4000;   // extra pause between batches
const MAX_RETRIES   = 4;      // max 429 retries per chunk

const sleep = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));

export interface EmbedItem {
  id: string;
  text: string;
}

async function embedWithBackoff(item: EmbedItem): Promise<number[] | null> {
  let delay = 30_000; // first backoff = 30 s
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await getEmbedding(item.text);
    } catch (err) {
      const msg = (err as Error).message ?? '';
      const is429 = msg.includes('429');

      if (!is429 || attempt === MAX_RETRIES) {
        logger.warn(
          { err, chunkId: item.id, attempt },
          'embeddingService: failed to embed chunk — will retry next startup'
        );
        return null;
      }

      logger.info(
        { chunkId: item.id, backoffMs: delay, attempt },
        'embeddingService: 429 — backing off'
      );
      await sleep(delay);
      delay = Math.min(delay * 2, 240_000); // cap at 4 min
    }
  }
  return null;
}

export async function generateEmbeddingsBatch(
  items: EmbedItem[],
  onProgress?: (done: number, total: number) => void
): Promise<Map<string, number[]>> {
  const results = new Map<string, number[]>();

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);

    for (const item of batch) {
      const vec = await embedWithBackoff(item);
      if (vec) {
        results.set(item.id, vec);
        onProgress?.(results.size, items.length);
      }
      await sleep(DELAY_MS);
    }

    if (i + BATCH_SIZE < items.length) await sleep(BETWEEN_BATCH);
  }

  return results;
}
