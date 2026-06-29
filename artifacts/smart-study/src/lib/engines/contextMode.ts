/**
 * CONTEXT MODE ARCHITECTURE — Phase 1
 *
 * Responsibility:
 *   Define the Mode Registry and Context Object pattern.
 *   Each mode produces a Context Object that the Sage Engine reads
 *   to decide how to handle the request.
 *
 * Design principles:
 *   - Modes do NOT call Gemini directly — they declare intent via ContextObject.
 *   - Adding a new mode requires: register here + create handler. No core chat refactoring.
 *   - LLM is decoupled — Context Object is model-agnostic.
 *   - Backend validates mode before processing. Frontend is never trusted blindly.
 *
 * Phase 1 scope:
 *   Wire existing UI selectors (curriculum / notes / exams / quiz) to real modes.
 *   Behavioral differentiation between modes is Phase 2.
 */

// ─── Mode Registry ────────────────────────────────────────────────────────────

export type ContextMode =
  | 'BOOK_MODE'
  | 'NOTES_MODE'
  | 'EXAM_MODE'
  | 'QUIZ_MODE';

// Future modes (Phase 2+) — registered here when handlers are ready:
// | 'PERFORMANCE_MODE'
// | 'WEAKNESS_MODE'
// | 'SMART_REVIEW_MODE'
// | 'STUDY_PLAN_MODE'
// | 'READINESS_MODE'

// ─── Context Object ───────────────────────────────────────────────────────────

/**
 * Context Object — the source of truth for how Sage handles a request.
 * The Sage Engine reads this object; it never reads mode directly.
 * This decouples mode identity from mode behavior.
 */
export interface ContextObject {
  mode: ContextMode;
  /** Whether to run RAG retrieval against curriculum chunks */
  useRAG: boolean;
  /** Whether to query the Exam Engine for past exam questions */
  useExamEngine: boolean;
  /** Whether to include the student's personal notes */
  useNotes: boolean;
  /** Whether external (non-curriculum) knowledge is permitted */
  allowExternalKnowledge: boolean;
  /** Whether to enforce strict curriculum-only answering */
  curriculumOnly: boolean;
  /** Whether to load student performance analytics */
  requiresStudentAnalytics: boolean;
}

// ─── Mode Registry (source of truth) ─────────────────────────────────────────

const MODE_REGISTRY: Record<ContextMode, ContextObject> = {
  BOOK_MODE: {
    mode: 'BOOK_MODE',
    useRAG: true,
    useExamEngine: false,
    useNotes: false,
    allowExternalKnowledge: false,
    curriculumOnly: true,
    requiresStudentAnalytics: false,
  },
  NOTES_MODE: {
    mode: 'NOTES_MODE',
    useRAG: true,
    useExamEngine: false,
    useNotes: true,
    allowExternalKnowledge: false,
    curriculumOnly: true,
    requiresStudentAnalytics: false,
  },
  EXAM_MODE: {
    mode: 'EXAM_MODE',
    useRAG: true,
    useExamEngine: true,
    useNotes: false,
    allowExternalKnowledge: false,
    curriculumOnly: true,
    requiresStudentAnalytics: false,
  },
  QUIZ_MODE: {
    mode: 'QUIZ_MODE',
    useRAG: true,
    useExamEngine: true,
    useNotes: false,
    allowExternalKnowledge: false,
    curriculumOnly: true,
    requiresStudentAnalytics: false,
  },
};

// ─── Public API ───────────────────────────────────────────────────────────────

/** All valid mode strings — used for validation on both frontend and backend. */
export const VALID_MODES: ContextMode[] = Object.keys(MODE_REGISTRY) as ContextMode[];

/**
 * Mode Handler Factory.
 * Returns the Context Object for the given mode.
 * Adding a new mode: (1) add to ContextMode type, (2) add entry here, (3) create handler.
 * No other file needs to change.
 */
export function buildContextObject(mode: ContextMode): ContextObject {
  return MODE_REGISTRY[mode];
}

/** Type guard — true if value is a registered ContextMode string. */
export function isValidMode(value: string): value is ContextMode {
  return (VALID_MODES as string[]).includes(value);
}

/**
 * Maps the UI resource selector IDs to their corresponding Context Modes.
 * Falls back to BOOK_MODE if the resource ID is unrecognised.
 */
export function resourceIdToMode(resourceId: string): ContextMode {
  const mapping: Record<string, ContextMode> = {
    curriculum: 'BOOK_MODE',
    notes: 'NOTES_MODE',
    exams: 'EXAM_MODE',
    quiz: 'QUIZ_MODE',
  };
  return mapping[resourceId] ?? 'BOOK_MODE';
}

/** Default mode when no resource is explicitly selected. */
export const DEFAULT_MODE: ContextMode = 'BOOK_MODE';
