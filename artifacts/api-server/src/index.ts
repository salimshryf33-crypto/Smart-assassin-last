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
import { runStartupValidation } from "./lib/examValidation";

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

  // Phase 1: Create all DB tables if they don't exist yet (idempotent)
  runStartupMigrations()
    .then(() =>
      // Phase 2: Restore disk cache from PostgreSQL (or seed DB from disk on first run).
      // Must run AFTER tables exist and BEFORE migrateIndex / relabelChapters.
      restoreCurriculumFromDB()
    )
    .then(() => {
      migrateIndex();
      relabelChapters();
    })
    .then(() => {
      // Phase 2: Curriculum Linking — scan for done exams with no approved link.
      // Fire-and-forget; never blocks server startup.
      setTimeout(() => {
        scanUnlinkedExams().catch((err) =>
          logger.error({ err }, 'startup: curriculum linking scan failed')
        );
      }, 12_000); // wait for curriculum restore + extraction recovery to settle
    })
    .catch((err) =>
      logger.error({ err }, 'startup: curriculum restore/migration failed')
    );

  // Generate vector embeddings for chunks that don't have them yet.
  generateMissingEmbeddings().catch((err) =>
    logger.error({ err }, 'generateMissingEmbeddings: unexpected error')
  );

  startResumeScheduler();

  // Start daily backup scheduler (runs at 02:00 UTC)
  startBackupScheduler();

  // Permanent fix: sync exam docs from index.json → exam_records, then extract.
  // Runs on every startup. Safe no-op if all records already exist and are done.
  syncAndRecoverExams().catch((err) =>
    logger.error({ err }, 'syncAndRecoverExams: unexpected error')
  );

  // Phase 1 Foundation: validate all extracted exam questions and derive canonical
  // answers for any MCQ with correct_answer = null.
  // Delayed 15s so syncAndRecoverExams has time to restore questions first.
  setTimeout(() => {
    runStartupValidation().catch((err) =>
      logger.error({ err }, 'runStartupValidation: unexpected error')
    );
  }, 15_000);
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
