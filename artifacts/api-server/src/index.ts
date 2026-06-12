import app from "./app";
import { logger } from "./lib/logger";
import { startResumeScheduler } from "./lib/resumeScheduler";
import { migrateIndex, relabelChapters } from "./lib/curriculumStorage";

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

  // Run safe startup migration (adds visibility/bookTitle defaults to legacy docs)
  migrateIndex();

  // Re-apply improved chapter detection to existing chunks (Phase 2 fix)
  // No-op when all chunks already have meaningful labels.
  relabelChapters();

  startResumeScheduler();
});
