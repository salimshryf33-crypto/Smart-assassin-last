/**
 * questionNormalizer — Phase 4 (Question Normalization) + Phase 5 (Enhanced Dedup)
 *
 * ARCHITECTURE RULE: Pure transformation layer. No DB access, no Gemini calls.
 * Uses generics so it works with any object containing a `question` string field.
 *
 * Phase 4 — Normalization:
 *   Fixes OCR artifacts: broken spacing, split lines, stray punctuation.
 *   Merges multi-line question fragments into single clean strings.
 *
 * Phase 5 — Enhanced Deduplication:
 *   Exact match (existing) + near-match via Jaccard similarity on word sets.
 *   Keeps the highest-quality version (longest, most complete).
 */

// ─── Constants ────────────────────────────────────────────────────────────────

/** Jaccard similarity threshold above which two questions are considered duplicates. */
const NEAR_DUPLICATE_THRESHOLD = 0.80;

/** Minimum question length (chars) to be considered valid. */
const MIN_QUESTION_LENGTH = 8;

/** Min Arabic content ratio — questions with <20% Arabic are likely OCR garbage. */
const MIN_ARABIC_RATIO = 0.15;

// ─── Phase 4: Normalization ───────────────────────────────────────────────────

/**
 * Normalize a single question text string.
 * Fixes the most common OCR artifacts in Arabic exam text.
 */
export function normalizeQuestionText(text: string): string {
  return (
    text
      // 1. Merge lines that belong to the same question
      //    A line ending mid-word (no punctuation) → join with space
      .replace(/([^\n.؟!،:؛])\n+([^\n])/g, '$1 $2')
      // 2. Collapse remaining newlines inside question
      .replace(/\n+/g, ' ')
      // 3. Collapse multiple spaces
      .replace(/[ \t]{2,}/g, ' ')
      // 4. Remove zero-width/invisible Unicode chars
      .replace(/[\u200b\u200c\u200d\u200e\u200f\ufeff]/g, '')
      // 5. Fix broken Arabic tatweel (kashida) runs left by OCR
      .replace(/ـ{3,}/g, 'ـ')
      // 6. Normalize Arabic-Indic numerals for consistency (keep as-is, just trim surrounding spaces)
      .replace(/\s*([٠١٢٣٤٥٦٧٨٩])\s*\./g, ' $1. ')
      // 7. Remove leading question number if it became isolated (e.g. "١ \n ما هو")
      .replace(/^([١٢٣٤٥٦٧٨٩\d]+[\s.)-]+)\s+/, '$1')
      // 8. Normalize ellipsis runs (OCR fill-blanks)
      .replace(/\.{5,}/g, '......')
      // 9. Final trim
      .trim()
  );
}

/**
 * Validate whether a parsed question is usable.
 * Filters out OCR garbage, page headers, and incomplete fragments.
 */
export function isValidQuestion(question: string): boolean {
  const q = question.trim();

  if (q.length < MIN_QUESTION_LENGTH) return false;

  // Must contain some Arabic content
  const arabicChars = (q.match(/[\u0600-\u06FF]/g) || []).length;
  const arabicRatio = arabicChars / q.length;
  if (arabicRatio < MIN_ARABIC_RATIO) return false;

  // Reject pure-number strings (page numbers, etc.)
  if (/^[\d٠١٢٣٤٥٦٧٨٩\s.،-]+$/.test(q)) return false;

  // Reject strings that are just repeated dots/dashes (fill-blank lines)
  const stripped = q.replace(/[.\-_\s]/g, '');
  if (stripped.length < 4) return false;

  return true;
}

/**
 * Normalize and validate an array of questions.
 * Returns only valid questions with cleaned text.
 * Generic: works with any object that has a `question: string` field.
 */
export function normalizeAll<T extends { question: string }>(questions: T[]): T[] {
  return questions
    .map(q => ({ ...q, question: normalizeQuestionText(q.question) }))
    .filter(q => isValidQuestion(q.question));
}

// ─── Phase 5: Enhanced Deduplication ─────────────────────────────────────────

/** Normalize text for comparison: lowercase, no diacritics, no punctuation, collapsed spaces. */
function normalizeForComparison(text: string): string {
  return text
    .replace(/[\u064B-\u065F]/g, '')   // Arabic diacritics (tashkeel)
    .replace(/[أإآ]/g, 'ا')           // Alef variants
    .replace(/ة/g, 'ه')               // Ta marbuta
    .replace(/[^\u0600-\u06FF\u0030-\u0039\u0020]/g, ' ')  // keep Arabic + digits
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Build a word-frequency map for Jaccard computation. */
function wordSet(text: string): Set<string> {
  return new Set(normalizeForComparison(text).split(' ').filter(Boolean));
}

/** Jaccard similarity: |A∩B| / |A∪B| */
function jaccardSimilarity(a: string, b: string): number {
  const setA = wordSet(a);
  const setB = wordSet(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const w of setA) if (setB.has(w)) intersection++;

  const union = setA.size + setB.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

/** Choose the higher-quality question between two near-duplicates. */
function pickBetter<T extends { question: string }>(a: T, b: T): T {
  // Prefer the one with more content (longer question text wins)
  if (b.question.length > a.question.length + 10) return b;
  return a;
}

export interface DeduplicationResult<T> {
  deduped: T[];
  exactRemoved: number;
  nearRemoved: number;
}

/**
 * Enhanced deduplication: exact match + near-match (Jaccard ≥ 0.80).
 * Keeps the highest-quality version of each duplicate pair.
 *
 * Phase 5 of the extraction quality engine.
 */
export function deduplicateEnhanced<T extends { question: string }>(
  questions: T[],
): DeduplicationResult<T> {
  if (questions.length === 0) {
    return { deduped: [], exactRemoved: 0, nearRemoved: 0 };
  }

  // ── Pass 1: Exact dedup (normalized comparison) ───────────────────────────
  let exactRemoved = 0;
  const seenExact = new Set<string>();
  const afterExact: T[] = [];

  for (const q of questions) {
    const key = normalizeForComparison(q.question);
    if (seenExact.has(key)) {
      exactRemoved++;
    } else {
      seenExact.add(key);
      afterExact.push(q);
    }
  }

  // ── Pass 2: Near-duplicate detection (Jaccard) ────────────────────────────
  // O(n²) but n ≤ ~150 per exam, so fine.
  let nearRemoved = 0;
  const removed = new Set<number>();
  const deduped: T[] = [];

  for (let i = 0; i < afterExact.length; i++) {
    if (removed.has(i)) continue;

    let best = afterExact[i]!;

    for (let j = i + 1; j < afterExact.length; j++) {
      if (removed.has(j)) continue;

      const sim = jaccardSimilarity(best.question, afterExact[j]!.question);
      if (sim >= NEAR_DUPLICATE_THRESHOLD) {
        best = pickBetter(best, afterExact[j]!);
        removed.add(j);
        nearRemoved++;
      }
    }

    deduped.push(best);
  }

  return { deduped, exactRemoved, nearRemoved };
}
