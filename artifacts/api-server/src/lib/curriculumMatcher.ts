/**
 * curriculumMatcher.ts
 *
 * Intelligent Curriculum Matching Engine — Phase 2
 *
 * Computes a confidence score (0–100) for every candidate curriculum document
 * against an uploaded exam, using four data-driven components:
 *
 *   Component 1 — Metadata alignment     (max 70 pts)
 *     Hard filter: country + grade + subject must all match.
 *     A document that fails any of the three is immediately excluded.
 *     Carries the highest weight because for small curriculum systems (1 book
 *     per subject/grade/country), metadata alone is near-sufficient for linking.
 *     Unique-match bonus: if there is only ONE candidate for the metadata triple,
 *     the score is 85 (nearly certain), otherwise 70.
 *
 *   Component 2 — Keyword Jaccard        (max 20 pts)
 *     Jaccard similarity between the unique token sets from all exam questions
 *     and the combined keyword corpus of all curriculum chunks.
 *     Note: exam vocabulary ≠ textbook vocabulary, so raw Jaccard is naturally
 *     low (~0–5%). This component acts as a tiebreaker between multiple books.
 *
 *   Component 3 — Chapter name overlap   (max 8 pts)
 *     Fraction of exam chapter labels that appear in the curriculum chapters.
 *
 *   Component 4 — Temporal alignment     (max 2 pts)
 *     Exam year vs. document upload year (best-effort; most exams lack this).
 *
 * Scores are weighted by [w1, w2, w3, w4].  Weights start at [1.0, 1.0, 1.0, 1.0]
 * and are updated automatically every time an admin approves or rejects a match
 * (Continuous Improvement — see reinforceMatch()).
 *
 * Rules:
 *   ≥ 90  → auto-approved (no admin action needed)
 *   ≥ 35  → pending_review (admin chooses)
 *   < 35  → no_match (admin links manually)
 *
 * Architecture:
 *   - Fully data-driven — no hardcoded subject / grade / country rules.
 *   - Zero Gemini calls in this module — pure in-memory computation.
 *   - Safe to run concurrently for multiple exams.
 *   - Weights persisted in Neon PostgreSQL (public.matcher_weights).
 */

import { readIndex, loadChunks, normalizeArabic, tokenize } from './curriculumStorage';
import { examStore }        from './examStore';
import { logger }           from './logger';
import { getSharedPool }    from './dbPool';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface ComponentScores {
  metadata:  number;   // 0–40
  keywords:  number;   // 0–35
  chapters:  number;   // 0–20
  temporal:  number;   // 0–5
}

export interface MatchCandidate {
  docId:      string;
  docTitle:   string;
  subject:    string;
  grade:      string;
  country:    string;
  confidence: number;           // 0–100 (weighted, normalised)
  components: ComponentScores;
  weights:    [number, number, number, number];
}

export interface MatchResult {
  examId:          string;
  candidates:      MatchCandidate[];
  bestCandidate:   MatchCandidate | null;
  autoApproved:    boolean;
  /**
   * True when the best candidate is the exam's own curriculumDocId —
   * i.e. the admin explicitly chose this curriculum at upload time.
   * Used by matchAndLink to force auto-approve regardless of confidence score.
   */
  isExplicitLink:  boolean;
  computedAt:      Date;
}

// ─── Constants ────────────────────────────────────────────────────────────────

export const AUTO_APPROVE_THRESHOLD = 90;
// Minimum confidence to show as pending_review rather than no_match.
// A pure metadata match (country+grade+subject) scores ~40 pts (40/100 = 40%).
// Setting threshold at 35 ensures any metadata-matched doc reaches pending_review,
// while reserving no_match ONLY for exams with genuinely zero curriculum candidates.
export const PENDING_THRESHOLD      = 35;

const DEFAULT_WEIGHTS: [number, number, number, number] = [1.0, 1.0, 1.0, 1.0];
// Max pts per component (must sum to 100 when all weights = 1.0):
//   metadata: 70 — dominant; country+grade+subject is near-sufficient in small systems.
//             Unique-match bonus: 85 when only 1 candidate exists (see scoring loop).
//   keywords: 20 — tiebreaker between multiple books for same subject (Jaccard naturally low)
//   chapters:  8 — tiebreaker via chapter label overlap
//   temporal:  2 — upload year vs. exam year (most exams lack this data)
const MAX_COMPONENTS:  [number, number, number, number] = [70, 20, 8, 2];
const LEARNING_RATE = 0.05;

// ─── Weight persistence (Neon) ────────────────────────────────────────────────

export async function loadWeights(): Promise<[number, number, number, number]> {
  try {
    const pool = getSharedPool();
    const res  = await pool.query<{ weights: unknown }>(
      `SELECT weights FROM public.matcher_weights WHERE id = 'global' LIMIT 1`
    );
    if (res.rows.length > 0) {
      const w = res.rows[0]!.weights;
      if (Array.isArray(w) && w.length === 4) {
        return w.map(Number) as [number, number, number, number];
      }
    }
  } catch (err) {
    logger.debug({ err }, 'curriculumMatcher: using default weights (DB unavailable)');
  }
  return [...DEFAULT_WEIGHTS] as [number, number, number, number];
}

export async function saveWeights(w: [number, number, number, number]): Promise<void> {
  try {
    const pool = getSharedPool();
    await pool.query(
      `INSERT INTO public.matcher_weights (id, weights, updated_at)
       VALUES ('global', $1::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET weights = $1::jsonb, updated_at = now()`,
      [JSON.stringify(w)]
    );
  } catch (err) {
    logger.warn({ err }, 'curriculumMatcher: failed to persist weights');
  }
}

// ─── Token extraction ─────────────────────────────────────────────────────────

function examKeywordSet(questions: Array<{ question: string; topic?: string | null; chapter?: string | null }>): Set<string> {
  const s = new Set<string>();
  for (const q of questions) {
    const text = [q.question, q.topic, q.chapter].filter(Boolean).join(' ');
    for (const tok of tokenize(text)) {
      if (tok.length >= 3) s.add(normalizeArabic(tok));
    }
  }
  return s;
}

function examChapterSet(questions: Array<{ chapter?: string | null }>): Set<string> {
  const s = new Set<string>();
  for (const q of questions) {
    if (q.chapter?.trim()) s.add(normalizeArabic(q.chapter.trim()));
  }
  return s;
}

// ─── Jaccard similarity ───────────────────────────────────────────────────────

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const v of a) { if (b.has(v)) intersection++; }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ─── Main matcher ─────────────────────────────────────────────────────────────

/**
 * Compute matching candidates for an exam.
 * Pure computation — no writes to DB.
 */
export async function matchExamToCurriculum(examId: string): Promise<MatchResult> {
  const computedAt = new Date();
  const weights    = await loadWeights();

  const [questions, examRecord] = await Promise.all([
    examStore.getQuestionsByExam(examId),
    examStore.getExamRecord(examId),
  ]);

  if (!examRecord) {
    logger.warn({ examId }, 'curriculumMatcher: exam record not found');
    return { examId, candidates: [], bestCandidate: null, autoApproved: false, isExplicitLink: false, computedAt };
  }

  if (questions.length === 0) {
    logger.warn({ examId }, 'curriculumMatcher: no questions — cannot match');
    return { examId, candidates: [], bestCandidate: null, autoApproved: false, isExplicitLink: false, computedAt };
  }

  const { country, grade, subject, year } = examRecord;

  // Build exam feature vectors
  const eKeywords = examKeywordSet(questions);
  const eChapters = examChapterSet(questions);

  // ─── Candidate pool ─────────────────────────────────────────────────────────
  // Strategy 1: exam.curriculumDocId is the explicit curriculum link set at
  //             upload time — always include it as the primary candidate.
  // Strategy 2: Normalised metadata search (country+grade+subject).
  //             Uses normaliseArabic + lowercase trim to survive spacing/diacritic
  //             differences that break exact === comparison.

  const allIndexed = readIndex().filter(
    (d) => d.docType !== 'exam' && (d.status === 'done' || d.status === 'partial')
  );

  // Helper: normalise for fuzzy comparison (strip diacritics, collapse spaces)
  const normStr = (s: string) => normalizeArabic(s).trim().replace(/\s+/g, ' ');

  // Strategy 1: explicit link set at upload time
  const ownDoc = examRecord.curriculumDocId
    ? allIndexed.find((d) => d.id === examRecord.curriculumDocId) ?? null
    : null;

  // Strategy 2: normalised metadata fallback (excluding ownDoc to avoid duplicates)
  const metaDocs = allIndexed.filter(
    (d) =>
      d.id !== examRecord.curriculumDocId &&
      normStr(d.country) === normStr(country) &&
      normStr(d.grade)   === normStr(grade)   &&
      normStr(d.subject) === normStr(subject)
  );

  // Combine — own doc is always first candidate (highest priority)
  const docs = ownDoc ? [ownDoc, ...metaDocs] : metaDocs;

  if (docs.length === 0) {
    logger.info(
      { examId, country, grade, subject, curriculumDocId: examRecord.curriculumDocId },
      'curriculumMatcher: no curriculum docs match metadata'
    );
    return { examId, candidates: [], bestCandidate: null, autoApproved: false, isExplicitLink: false, computedAt };
  }

  const candidates: MatchCandidate[] = [];

  // Unique-match bonus: when there is exactly ONE candidate for this
  // country+grade+subject triple, the metadata signal alone is near-conclusive.
  // Boost metadata score from 70 → 85 so the confidence clearly lands in
  // pending_review territory and signals high certainty to the admin.
  const isUniqueCandidate = docs.length === 1;

  for (const doc of docs) {
    const chunks = loadChunks(doc.id);

    // ── Component 1: Metadata ─────────────────────────────────────────────────
    // Every candidate here already passed the country+grade+subject hard filter.
    // Unique-match bonus: 85 pts when this is the only candidate (unambiguous),
    // 70 pts when competing against other books for the same metadata triple.
    const metadata = isUniqueCandidate ? 85 : 70;

    // ── Component 2: Keyword Jaccard (max 20 pts) ─────────────────────────────
    // Exam question vocabulary ≠ textbook explanation vocabulary, so raw Jaccard
    // is naturally low (~0–5%). Acts as a tiebreaker between multiple books.
    const docKeywords = new Set<string>();
    for (const chunk of chunks) {
      for (const kw of chunk.keywords) {
        const n = normalizeArabic(kw);
        if (n.length >= 3) docKeywords.add(n);
      }
      // Also tokenize raw content (picks up vocabulary not in keyword list)
      for (const tok of tokenize(chunk.content)) {
        if (tok.length >= 3) docKeywords.add(normalizeArabic(tok));
      }
    }
    const keywords = jaccard(eKeywords, docKeywords) * 20;

    // ── Component 3: Chapter overlap (max 8 pts) ──────────────────────────────
    const docChapters = new Set<string>();
    for (const chunk of chunks) {
      if (chunk.chapter?.trim()) docChapters.add(normalizeArabic(chunk.chapter.trim()));
    }
    const chapterOverlap = eChapters.size > 0
      ? [...eChapters].filter((c) => docChapters.has(c)).length / eChapters.size
      : 0;
    const chapters = chapterOverlap * 8;

    // ── Component 4: Temporal alignment (max 2 pts) ───────────────────────────
    let temporal = 0;
    if (year && doc.uploadedAt) {
      const docYear = new Date(doc.uploadedAt).getFullYear().toString();
      if (docYear === year.slice(0, 4)) temporal = 2;
    }

    const components: ComponentScores = { metadata, keywords, chapters, temporal };

    // ── Weighted confidence (0–100) ───────────────────────────────────────────
    const rawScore =
      weights[0]! * metadata +
      weights[1]! * keywords +
      weights[2]! * chapters +
      weights[3]! * temporal;

    // maxPossible uses MAX_COMPONENTS (not the actual metadata score) so that
    // the unique-match bonus (85 instead of 70) naturally pushes confidence above
    // the 70% "normal" ceiling — capped at 100 via Math.min below.
    const maxPossible =
      weights[0]! * MAX_COMPONENTS[0]! +   // 70
      weights[1]! * MAX_COMPONENTS[1]! +   // 20
      weights[2]! * MAX_COMPONENTS[2]! +   // 8
      weights[3]! * MAX_COMPONENTS[3]!;    // 2

    const confidence =
      maxPossible > 0
        ? Math.min(100, Math.round((rawScore / maxPossible) * 10_000) / 100)
        : 0;

    candidates.push({
      docId:     doc.id,
      docTitle:  doc.bookTitle ?? doc.filename ?? doc.id,
      subject:   doc.subject,
      grade:     doc.grade,
      country:   doc.country,
      confidence,
      components,
      weights: [...weights] as [number, number, number, number],
    });
  }

  // Sort descending by confidence
  candidates.sort((a, b) => b.confidence - a.confidence);

  const best           = candidates[0] ?? null;
  const autoApproved   = best !== null && best.confidence >= AUTO_APPROVE_THRESHOLD;
  // isExplicitLink: true when the top candidate is the exam's own curriculumDocId.
  // matchAndLink uses this to force auto-approve even when confidence < 90.
  const isExplicitLink = ownDoc !== null && best !== null && best.docId === ownDoc.id;

  logger.info(
    {
      examId,
      country, grade, subject,
      ownDocId:       examRecord.curriculumDocId,
      docsEvaluated:  candidates.length,
      bestDocId:      best?.docId,
      bestConfidence: best?.confidence,
      autoApproved,
      isExplicitLink,
    },
    'curriculumMatcher: matching complete'
  );

  return { examId, candidates, bestCandidate: best, autoApproved, isExplicitLink, computedAt };
}

// ─── Continuous improvement ───────────────────────────────────────────────────

/**
 * Update weights based on admin feedback.
 *
 * On APPROVAL:  reinforce components that scored high (they were useful).
 * On REJECTION: penalise components that dominated the wrong recommendation.
 *
 * Weights are bounded [0.1, 2.0] and normalised so their sum stays at 4.0
 * (preserving the original scale).
 *
 * Stored persistently in Neon → public.matcher_weights.
 */
export async function reinforceMatch(
  components: ComponentScores,
  approved: boolean
): Promise<void> {
  const weights = await loadWeights();

  const scores: [number, number, number, number] = [
    components.metadata,
    components.keywords,
    components.chapters,
    components.temporal,
  ];

  for (let i = 0; i < 4; i++) {
    const contribution = MAX_COMPONENTS[i]! > 0
      ? scores[i]! / MAX_COMPONENTS[i]!
      : 0;

    if (approved) {
      weights[i] = Math.min(2.0, weights[i]! + LEARNING_RATE * contribution);
    } else {
      weights[i] = Math.max(0.1, weights[i]! - LEARNING_RATE * contribution);
    }
  }

  // Normalise: sum of weights must remain 4.0
  const sum    = weights.reduce((s, w) => s + w, 0);
  const factor = 4 / sum;
  for (let i = 0; i < 4; i++) {
    weights[i] = Math.round(weights[i]! * factor * 10_000) / 10_000;
  }

  await saveWeights(weights);

  logger.info(
    { approved, weights },
    'curriculumMatcher: weights updated (continuous improvement)'
  );
}
