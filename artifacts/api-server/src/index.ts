import app from "./app";
import { logger } from "./lib/logger";
import { startResumeScheduler } from "./lib/resumeScheduler";
import { migrateIndex, relabelChapters, generateMissingEmbeddings } from "./lib/curriculumStorage";
import { triggerQuestionExtraction, DailyQuotaExhaustedError } from "./lib/questionExtractor";
import { examStore } from "./lib/examStore";
import { runStartupMigrations } from "./lib/dbMigrations";
import { startBackupScheduler } from "./lib/backupScheduler";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Phase 1: Create security/stability DB tables if they don't exist yet
  runStartupMigrations().catch((err) =>
    logger.error({ err }, 'runStartupMigrations: unexpected error')
  );

  // Run safe startup migration (adds visibility/bookTitle defaults to legacy docs)
  migrateIndex();

  // Re-apply improved chapter detection to existing chunks (Phase 2 fix)
  // No-op when all chunks already have meaningful labels.
  relabelChapters();

  // Generate vector embeddings for chunks that don't have them yet.
  // Runs fully async in the background — never blocks the server.
  // Embeddings are stored in existing chunk JSON files, no DB writes.
  generateMissingEmbeddings().catch((err) =>
    logger.error({ err }, 'generateMissingEmbeddings: unexpected error')
  );

  startResumeScheduler();

  // Feature 4: Start daily backup scheduler (runs at 02:00 UTC)
  startBackupScheduler();

  // Auto-recover pending/stuck exam records — runs once on startup.
  // Safe: no-op if all exams are already 'done'.
  autoRecoverPendingExams().catch((err) =>
    logger.error({ err }, 'autoRecoverPendingExams: unexpected error')
  );
});

// ─── Startup auto-recovery for pending exam records ───────────────────────────
async function autoRecoverPendingExams(): Promise<void> {
  // Small delay to let the server fully warm up first
  await new Promise(r => setTimeout(r, 5_000));

  const all = await examStore.listExamRecords({ userId: '', isAdmin: true });
  const pending = all.filter(r =>
    r.extractionStatus === 'pending' ||
    r.extractionStatus === 'extracting' ||
    r.extractionStatus === 'error' ||
    // 'done' with 0 questions means extraction was blocked (e.g. by daily quota)
    (r.extractionStatus === 'done' && r.questionCount === 0)
  );

  if (pending.length === 0) {
    logger.info('autoRecoverPendingExams: no pending exams found');
    return;
  }

  logger.info({ count: pending.length }, 'autoRecoverPendingExams: starting recovery');

  for (let i = 0; i < pending.length; i++) {
    const rec = pending[i]!;
    if (i > 0) {
      // 45s cooldown between exams to avoid Gemini rate limits
      await new Promise(r => setTimeout(r, 45_000));
    }
    logger.info({ examId: rec.examId, title: rec.title }, 'autoRecoverPendingExams: triggering extraction');
    try {
      await triggerQuestionExtraction(rec.curriculumDocId);
      logger.info({ examId: rec.examId }, 'autoRecoverPendingExams: extraction complete');
    } catch (err) {
      if (err instanceof DailyQuotaExhaustedError) {
        logger.error(
          { examId: rec.examId, remaining: pending.length - i - 1 },
          'autoRecoverPendingExams: daily Gemini quota exhausted — stopping. Remaining exams will retry on next restart'
        );
        return; // Stop processing — quota resets at UTC midnight
      }
      logger.error({ err, examId: rec.examId }, 'autoRecoverPendingExams: extraction failed');
    }
  }

  logger.info({ count: pending.length }, 'autoRecoverPendingExams: all done');
}
