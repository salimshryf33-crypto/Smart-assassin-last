/**
 * questionStorage — Persistent JSON backup for extracted exam questions.
 *
 * PURPOSE:
 *   Questions extracted via Gemini are saved to PostgreSQL for runtime use,
 *   BUT PostgreSQL can be wiped on environment changes. This module writes a
 *   JSON snapshot to disk (committed to git) so that questions survive any DB
 *   reset without needing a Gemini re-extraction.
 *
 * FILE LOCATION:
 *   data/curriculum/questions/{examId}.json
 *
 * FLOW:
 *   Extraction (once):  Gemini → PostgreSQL  +  questionStorage.save()
 *   Every restart:      questionStorage.load() → PostgreSQL  (if DB is empty)
 *
 * ARCHITECTURE RULE:
 *   Pure file-system layer. No DB access, no Gemini calls.
 *   Always additive — never deletes or modifies existing questions.
 */

import fs   from 'fs';
import path from 'path';
import type { InsertExamQuestion } from '@workspace/db';
import { logger } from './logger';

// ─── Path helpers ─────────────────────────────────────────────────────────────

const DATA_DIR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../../data/curriculum/questions'
);

/** Strict UUID v4 pattern — rejects any path-traversal attempts (e.g. "../etc"). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertSafeExamId(examId: string): void {
  if (!UUID_RE.test(examId)) {
    throw new Error(`Invalid examId — must be a UUID: "${examId}"`);
  }
}

function questionFilePath(examId: string): string {
  assertSafeExamId(examId);
  return path.join(DATA_DIR, `${examId}.json`);
}

// ─── File format ──────────────────────────────────────────────────────────────

interface QuestionSnapshot {
  version:   1;
  examId:    string;
  savedAt:   string;       // ISO timestamp
  count:     number;
  questions: InsertExamQuestion[];
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Persist extracted questions to a JSON file on disk.
 * Called after every successful Gemini extraction.
 * Idempotent — overwrites any existing snapshot.
 */
export function saveQuestionsToFile(
  examId: string,
  questions: InsertExamQuestion[],
): void {
  if (questions.length === 0) return;

  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });

    const snapshot: QuestionSnapshot = {
      version:   1,
      examId,
      savedAt:   new Date().toISOString(),
      count:     questions.length,
      questions,
    };

    fs.writeFileSync(
      questionFilePath(examId),
      JSON.stringify(snapshot, null, 2),
      'utf8'
    );

    logger.info(
      { examId, count: questions.length, path: questionFilePath(examId) },
      'questionStorage: saved questions to JSON snapshot'
    );
  } catch (err) {
    // Never crash the extraction pipeline on a save failure — log and continue.
    logger.error(
      { examId, err: String(err) },
      'questionStorage: failed to save JSON snapshot (non-fatal)'
    );
  }
}

/**
 * Load questions from the JSON snapshot for an exam.
 * Returns the array if the file exists and is valid, otherwise null.
 */
export function loadQuestionsFromFile(
  examId: string,
): InsertExamQuestion[] | null {
  const filePath = questionFilePath(examId);

  if (!fs.existsSync(filePath)) return null;

  try {
    const raw      = fs.readFileSync(filePath, 'utf8');
    const snapshot = JSON.parse(raw) as QuestionSnapshot;

    if (snapshot.version !== 1 || !Array.isArray(snapshot.questions)) {
      logger.warn(
        { examId, filePath },
        'questionStorage: snapshot format invalid — ignoring'
      );
      return null;
    }

    if (snapshot.questions.length === 0) return null;

    logger.info(
      { examId, count: snapshot.questions.length, savedAt: snapshot.savedAt },
      'questionStorage: loaded questions from JSON snapshot'
    );

    return snapshot.questions;
  } catch (err) {
    logger.error(
      { examId, filePath, err: String(err) },
      'questionStorage: failed to parse JSON snapshot — ignoring'
    );
    return null;
  }
}

/**
 * Returns true when a valid non-empty snapshot exists for this exam.
 * Used as a fast guard before deciding whether to call Gemini.
 */
export function hasQuestionsSnapshot(examId: string): boolean {
  const filePath = questionFilePath(examId);
  if (!fs.existsSync(filePath)) return false;

  try {
    const raw      = fs.readFileSync(filePath, 'utf8');
    const snapshot = JSON.parse(raw) as QuestionSnapshot;
    return snapshot.version === 1 && Array.isArray(snapshot.questions) && snapshot.questions.length > 0;
  } catch {
    return false;
  }
}

/**
 * Returns the absolute path to the questions directory (for diagnostics).
 */
export function getQuestionsDir(): string {
  return DATA_DIR;
}
