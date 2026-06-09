import fs from 'node:fs';
import { logger } from './logger';
import { readIndex, upsertDocMeta, getDocMeta, getPdfPath } from './curriculumStorage';
import { resumeDoc, hasActiveJob } from './curriculumQueue';

const STARTUP_DELAY_MS = 8_000;
const INTERVAL_MS = 15 * 60 * 1_000;

async function runScheduler(): Promise<void> {
  const partialDocs = readIndex().filter((doc) => {
    if (doc.status !== 'partial') return false;
    if (hasActiveJob(doc.id)) return false;
    const pdfPath = doc.pdfStoragePath ?? getPdfPath(doc.id);
    return fs.existsSync(pdfPath);
  });

  if (partialDocs.length === 0) {
    logger.debug('ResumeScheduler: no resumable partial docs');
    return;
  }

  logger.info(
    { count: partialDocs.length, docs: partialDocs.map((d) => d.id) },
    'ResumeScheduler: found partial docs — attempting auto-resume'
  );

  for (const doc of partialDocs) {
    const now = Date.now();

    const fresh = getDocMeta(doc.id);
    if (!fresh || fresh.status !== 'partial') {
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
