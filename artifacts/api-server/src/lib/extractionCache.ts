/**
 * extractionCache — Phase 7 (Performance / Gemini Usage Reduction)
 *
 * In-memory cache for successful per-chunk Gemini extraction results.
 * Keyed by a hash of chunk content — same content never re-sent to Gemini.
 *
 * Cache persists for the lifetime of the server process.
 * Resets on restart (acceptable — extraction is idempotent).
 *
 * ARCHITECTURE RULE: Never persisted to disk or DB.
 * Source-of-truth for extracted questions is always exam_questions table.
 * This cache only reduces redundant Gemini API calls within one server run.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

interface CachedEntry<T> {
  questions: T[];
  cachedAt: number;   // Date.now()
}

interface CacheStats {
  size: number;
  hits: number;
  misses: number;
  hitRate: string;
}

// ─── Internal state ───────────────────────────────────────────────────────────

const cache = new Map<string, CachedEntry<unknown>>();
let hits   = 0;
let misses = 0;

// ─── Hash function ────────────────────────────────────────────────────────────

/**
 * FNV-1a hash of the first 600 chars + length of the content.
 * Good enough to uniquely identify a chunk; fast to compute.
 */
function hashContent(content: string): string {
  const sample = content.slice(0, 600) + '|' + content.length;
  let h = 0x811c9dc5;
  for (let i = 0; i < sample.length; i++) {
    h ^= sample.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Look up cached extraction results for a chunk.
 * Returns the cached array of questions, or null if not cached.
 */
export function getCachedExtraction<T>(content: string): T[] | null {
  const key   = hashContent(content);
  const entry = cache.get(key) as CachedEntry<T> | undefined;
  if (entry) {
    hits++;
    return entry.questions;
  }
  misses++;
  return null;
}

/**
 * Store extraction results for a chunk.
 * Only call when extraction succeeded (non-empty questions array).
 */
export function setCachedExtraction<T>(content: string, questions: T[]): void {
  if (questions.length === 0) return; // Never cache empty results
  const key = hashContent(content);
  cache.set(key, { questions, cachedAt: Date.now() });
}

/**
 * Return cache statistics for diagnostics / Phase 8 report.
 */
export function getExtractionCacheStats(): CacheStats {
  const total = hits + misses;
  return {
    size: cache.size,
    hits,
    misses,
    hitRate: total > 0 ? `${((hits / total) * 100).toFixed(1)}%` : '0%',
  };
}

/**
 * Clear the entire cache (useful for testing / forced re-extraction).
 */
export function clearExtractionCache(): void {
  cache.clear();
  hits   = 0;
  misses = 0;
}
