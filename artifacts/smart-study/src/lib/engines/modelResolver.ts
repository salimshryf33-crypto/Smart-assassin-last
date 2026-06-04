/**
 * SHARED MODEL RESOLVER
 *
 * Single source of truth for Gemini model discovery.
 * Both Answer Engine and Flashcard Gen Engine must use this.
 * Caches the resolved model in memory after first successful lookup.
 */

// gemini-1.5-flash-latest is no longer available in the API.
// gemini-2.5-flash is the current stable replacement (1M token input, 65k output).
const DEFAULT_MODEL = 'gemini-2.5-flash';

let _cachedModel: string | null = null;

export async function resolveModel(): Promise<string> {
  if (_cachedModel) return _cachedModel;
  try {
    const res = await fetch('/api/gemini/models');
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
        console.log('[ModelResolver] Resolved model:', _cachedModel);
        return _cachedModel;
      }
    }
  } catch {
    /* fall through to default */
  }
  _cachedModel = DEFAULT_MODEL;
  console.warn('[ModelResolver] Model discovery failed, using default:', _cachedModel);
  return _cachedModel;
}
