import app from "./app";
import { logger } from "./lib/logger";
import { startResumeScheduler } from "./lib/resumeScheduler";
import { migrateIndex, relabelChapters, generateMissingEmbeddings, readIndex } from "./lib/curriculumStorage";
import { triggerQuestionExtraction, DailyQuotaExhaustedError } from "./lib/questionExtractor";
import { examStore } from "./lib/examStore";
import { runStartupMigrations } from "./lib/dbMigrations";
import { startBackupScheduler } from "./lib/backupScheduler";
import { restoreCurriculumFromDB } from "./lib/curriculumPersistence";
import { scanUnlinkedExams } from "./lib/curriculumLinker";
import { hasQuestionsSnapshot, loadQuestionsFromFile } from "./lib/questionStorage";
import { runStartupValidation, startRetryScheduler, initPreparationQueue, syncAllPreparationStatuses } from "./lib/examValidation";
import { startMetricsFlushTimer } from "./lib/observability/metricsCollector";

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

  // ── Stage A: DB tables + curriculum cache ─────────────────────────────────
  // This Promise resolves once:
  //   1. All tables exist (runStartupMigrations)
  //   2. Chunk JSON files are restored from PostgreSQL to disk (restoreCurriculumFromDB)
  //   3. Index is migrated and chapters are labelled (migrateIndex / relabelChapters)
  //
  // Curriculum chunks must be in memory before the validation pipeline runs,
  // because searchChunks() loads chunks lazily via loadChunks() which reads
  // the disk cache — and that cache is only populated after step 2.
  const curriculumReady: Promise<void> = runStartupMigrations()
    .then(() => restoreCurriculumFromDB())
    .then(() => {
      migrateIndex();
      relabelChapters();
    })
    .catch((err) => {
      logger.error({ err }, 'startup: curriculum restore/migration failed');
    });

  // Curriculum Linking — keep its existing 12s settle window but anchor it
  // to the curriculum chain completing rather than an absolute timer.
  curriculumReady.then(() => {
    setTimeout(() => {
      scanUnlinkedExams().catch((err) =>
        logger.error({ err }, 'startup: curriculum linking scan failed')
      );
    }, 12_000);
  });

  // Generate vector embeddings for chunks that don't have them yet (independent).
  generateMissingEmbeddings().catch((err) =>
    logger.error({ err }, 'generateMissingEmbeddings: unexpected error')
  );

  startResumeScheduler();

  // Start daily backup scheduler (runs at 02:00 UTC).
  startBackupScheduler();

  // Phase 5: periodic metrics flush (durable rollups, never memory-only).
  startMetricsFlushTimer();

  // ── Stage B: Exam extraction / snapshot restore ────────────────────────────
  // Resolves once all exam docs are synced and any pending extraction is done.
  // JSON-snapshot exams resolve quickly; Gemini extraction can take minutes.
  const examsReady: Promise<void> = syncAndRecoverExams().catch((err) => {
    logger.error({ err }, 'syncAndRecoverExams: unexpected error');
  });

  // ── Stage C: Validation startup + retry scheduler ──────────────────────────
  // Phase 3 (event-driven): validation begins ONLY after BOTH:
  //   • curriculum chunks are in the disk/memory cache   (curriculumReady)
  //   • exam questions are in the database               (examsReady)
  //
  // This eliminates the previous 15-second hardcoded timer and guarantees
  // searchChunks() never returns empty results due to a restore-timing race.
  Promise.all([curriculumReady, examsReady])
    .then(async () => {
      // Phase 6: init preparation queue — enqueues backlog exams before validation
      await initPreparationQueue().catch((err: unknown) =>
        logger.error({ err }, 'startup: initPreparationQueue failed'),
      );
      // Backfill preparation_status from current canonical answer states
      await syncAllPreparationStatuses().catch((err: unknown) =>
        logger.error({ err }, 'startup: syncAllPreparationStatuses failed'),
      );
      await runStartupValidation();
      // Start the periodic retry/preparation scheduler after the initial scan.
      // Scheduler fires every 5 min, throttled to MAX_CONCURRENT_EXAMS per tick.
      startRetryScheduler();
    })
    .catch((err) =>
      logger.error({ err }, 'startup: validation/scheduler startup failed')
    );
});

// ─── Sync index.json exam docs → exam_records, then extract pending ───────────
//
// This is the "forever fix":
//   1. Read all docs with docType='exam' from index.json (disk — survives Git)
//   2. For each one missing from exam_records, insert a 'pending' record
//   3. Then run extraction on all pending/error/stuck records
//
// Result: migrating to any new Replit account / DB just requires a server start.
async function syncAndRecoverExams(): Promise<void> {
  // Small delay to let DB tables finish being created
  await new Promise(r => setTimeout(r, 5_000));

  // ── Step 1: sync index.json → exam_records ────────────────────────────────
  try {
    const allDocs = readIndex();
    const examDocs = allDocs.filter(d => d.docType === 'exam');

    if (examDocs.length > 0) {
      const existingRecords = await examStore.listExamRecords({ userId: '', isAdmin: true });
      const existingIds = new Set(existingRecords.map(r => r.examId));

      const missing = examDocs.filter(d => !existingIds.has(d.id));

      if (missing.length > 0) {
        logger.info({ count: missing.length }, 'syncAndRecoverExams: inserting missing exam records from index.json');
        for (const doc of missing) {
          await examStore.upsertExamRecord({
            examId:           doc.id,
            curriculumDocId:  doc.id,
            title:            doc.filename ?? doc.id,
            subject:          doc.subject,
            grade:            doc.grade,
            country:          doc.country,
            track:            doc.track ?? null,
            ownerId:          doc.ownerId ?? null,
            visibility:       doc.visibility ?? 'private',
            examType:         'final',
            extractionStatus: 'pending',
            questionCount:    0,
          });
          logger.info({ docId: doc.id, title: doc.filename }, 'syncAndRecoverExams: created pending record');
        }
      } else {
        logger.info('syncAndRecoverExams: all exam docs already have records');
      }
    }
  } catch (err) {
    logger.error({ err }, 'syncAndRecoverExams: sync step failed');
  }

  // ── Step 2: extract pending/stuck records ─────────────────────────────────
  const all = await examStore.listExamRecords({ userId: '', isAdmin: true });
  const pending = all.filter(r =>
    r.extractionStatus === 'pending' ||
    r.extractionStatus === 'extracting' ||
    r.extractionStatus === 'error' ||
    (r.extractionStatus === 'done' && r.questionCount === 0)
  );

  if (pending.length === 0) {
    logger.info('syncAndRecoverExams: no pending exams — all done');
    return;
  }

  logger.info({ count: pending.length }, 'syncAndRecoverExams: starting extraction');

  // Track whether any exam still needs Gemini (for cooldown logic)
  let geminiCallIndex = 0;

  for (let i = 0; i < pending.length; i++) {
    const rec = pending[i]!;

    // ── JSON snapshot restore: instant, no Gemini, no quota ──────────────────
    if (hasQuestionsSnapshot(rec.examId)) {
      logger.info(
        { examId: rec.examId, title: rec.title },
        'syncAndRecoverExams: JSON snapshot found — restoring from disk (no Gemini)'
      );
      try {
        const questions = loadQuestionsFromFile(rec.examId);
        if (questions && questions.length > 0) {
          await examStore.saveQuestions(questions);
          await examStore.upsertExamRecord({
            ...rec,
            extractionStatus: 'done',
            questionCount:    questions.length,
            extractionError:  null,
            extractedAt:      new Date(),
          });
          logger.info(
            { examId: rec.examId, count: questions.length },
            'syncAndRecoverExams: restored from JSON snapshot successfully'
          );
          continue;   // skip Gemini for this exam
        }
      } catch (restoreErr) {
        logger.warn(
          { examId: rec.examId, err: String(restoreErr) },
          'syncAndRecoverExams: JSON restore failed — falling through to Gemini extraction'
        );
      }
    }

    // ── Gemini extraction (only when no JSON snapshot exists) ─────────────────
    if (geminiCallIndex > 0) {
      // 45s cooldown between Gemini calls to avoid rate limits
      await new Promise(r => setTimeout(r, 45_000));
    }
    geminiCallIndex++;

    logger.info({ examId: rec.examId, title: rec.title }, 'syncAndRecoverExams: triggering Gemini extraction');
    try {
      await triggerQuestionExtraction(rec.curriculumDocId);
      logger.info({ examId: rec.examId }, 'syncAndRecoverExams: extraction complete');
    } catch (err) {
      if (err instanceof DailyQuotaExhaustedError) {
        logger.error(
          { examId: rec.examId, remaining: pending.length - i - 1 },
          'syncAndRecoverExams: daily Gemini quota exhausted — will retry on next restart'
        );
        return;
      }
      logger.error({ err, examId: rec.examId }, 'syncAndRecoverExams: extraction failed');
    }
  }

  logger.info({ count: pending.length }, 'syncAndRecoverExams: all extractions complete');
}
