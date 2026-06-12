import fs from 'node:fs';
import { logger } from './logger';
import { readIndex, upsertDocMeta, getDocMeta, getPdfPath } from './curriculumStorage';
import { resumeDoc, hasActiveJob } from './curriculumQueue';
import { restorePdfFromDb } from './pdfPersistence';

const STARTUP_DELAY_MS = 8_000;
const INTERVAL_MS = 15 * 60 * 1_000;
// Maximum number of auto-resume attempts for docs stuck in 'error' due to
// transient Gemini failures (503 / OCR unavailable).
const MAX_ERROR_RESUME_ATTEMPTS = 5;

/** Returns true if an 'error' doc failed due to a transient OCR/Gemini issue. */
function isTransientOcrError(errorMessage: string | undefined): boolean {
  if (!errorMessage) return false;
  return (
    errorMessage.includes('503') ||
    errorMessage.includes('OCR service is unavailable') ||
    errorMessage.includes('ServiceUnavailableError') ||
    errorMessage.includes('0 usable pages') ||
    errorMessage.includes('service overloaded')
  );
}

async function runScheduler(): Promise<void> {
  const allDocs = readIndex();

  // Docs that are 'partial' — always resumable.
  const partialDocs = allDocs.filter((doc) =>
    doc.status === 'partial' && !hasActiveJob(doc.id)
  );

  // Docs stuck in 'error' due to a transient Gemini/OCR failure — also resumable.
  const errorDocs = allDocs.filter((doc) =>
    doc.status === 'error' &&
    !hasActiveJob(doc.id) &&
    (doc.resumeAttempts ?? 0) < MAX_ERROR_RESUME_ATTEMPTS &&
    isTransientOcrError(doc.errorMessage)
  );

  const resumeCandidates = [...partialDocs, ...errorDocs];

  if (resumeCandidates.length === 0) {
    logger.debug('ResumeScheduler: no resumable docs');
    return;
  }

  // ── Ensure PDF is on disk (restore from DB if needed) ──────────────────────
  const resumable: typeof resumeCandidates = [];
  for (const doc of resumeCandidates) {
    const pdfPath = getPdfPath(doc.id);
    if (fs.existsSync(pdfPath)) {
      resumable.push(doc);
    } else {
      try {
        const restored = await restorePdfFromDb(doc.id, pdfPath);
        if (restored) {
          logger.info(
            { docId: doc.id, pdfPath },
            'ResumeScheduler: PDF restored from database to disk'
          );
          resumable.push(doc);
        } else {
          logger.warn(
            { docId: doc.id, pdfPath },
            'ResumeScheduler: PDF missing from both disk and database — cannot resume. ' +
            'User must re-upload the file.'
          );
        }
      } catch (restoreErr) {
        logger.error(
          { docId: doc.id, err: restoreErr },
          'ResumeScheduler: failed to restore PDF from database'
        );
      }
    }
  }

  if (resumable.length === 0) {
    logger.debug('ResumeScheduler: no resumable docs (PDFs unavailable)');
    return;
  }

  logger.info(
    { count: resumable.length, docs: resumable.map((d) => d.id) },
    'ResumeScheduler: found resumable docs — attempting auto-resume'
  );

  for (const doc of resumable) {
    const now = Date.now();

    const fresh = getDocMeta(doc.id);
    if (!fresh || (fresh.status !== 'partial' && fresh.status !== 'error')) {
      logger.debug({ docId: doc.id }, 'ResumeScheduler: doc status changed, skipping');
      continue;
    }
    if (hasActiveJob(doc.id)) {
      logger.debug({ docId: doc.id }, 'ResumeScheduler: active job exists, skipping');
      continue;
    }

    const nextAttempt = (fresh.resumeAttempts ?? 0) + 1;

    upsertDocMeta({
      ...fresh,
      lastResumeAttempt: now,
      resumeAttempts: nextAttempt,
      lastResumeError: undefined,
    });

    try {
      await resumeDoc(doc.id);
      logger.info(
        {
          docId: doc.id,
          filename: doc.filename,
          lastRenderedPage: fresh.lastRenderedPage,
          attempt: nextAttempt,
          fromStatus: fresh.status,
        },
        'ResumeScheduler: resume job queued'
      );
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.warn(
        { docId: doc.id, err: errorMsg, attempt: nextAttempt },
        'ResumeScheduler: failed to queue resume job'
      );
      const current = getDocMeta(doc.id);
      if (current) {
        upsertDocMeta({
          ...current,
          lastResumeError: errorMsg,
        });
      }
    }
  }
}

export function startResumeScheduler(): void {
  logger.info(
    { startupDelayMs: STARTUP_DELAY_MS, intervalMs: INTERVAL_MS },
    'ResumeScheduler: initialising'
  );

  setTimeout(() => {
    runScheduler().catch((err) =>
      logger.error({ err }, 'ResumeScheduler: startup run failed')
    );
  }, STARTUP_DELAY_MS);

  setInterval(() => {
    runScheduler().catch((err) =>
      logger.error({ err }, 'ResumeScheduler: scheduled run failed')
    );
  }, INTERVAL_MS);
}
