/**
 * examValidation/index.ts
 *
 * Public API for the Exam Validation Pipeline and Canonical Answer Layer.
 *
 * Import from here — not from individual module files.
 */

export { runValidationForExam, runStartupValidation, healOrphanQuestions } from './validationPipeline';
export { getPublishReadiness, listByExamId, countUnready } from './canonicalAnswerStore';
export { CONFIDENCE_THRESHOLD, DailyQuotaExhaustedError } from './canonicalAnswerDeriver';
export { startRetryScheduler, stopRetryScheduler } from './retryScheduler';
export { MAX_VALIDATION_ATTEMPTS } from './retryPolicy';
export { initPreparationQueue, getQueueOverview, listPendingJobs, enqueueExam } from './preparationQueue';
export { syncPreparationStatus, syncAllPreparationStatuses, getPreparationSummary } from './examPreparationStatus';
export { listDLQ, getDLQEntry, getDLQStats, resolveDLQ, recordDLQRetry, insertDLQ } from './deadLetterQueue';
export type {
  CanonicalAnswer,
  ValidationStatus,
  PublishReadinessResult,
  PipelineQuestion,
} from './types';
export type { PreparationJob, QueueOverview, JobStatus } from './preparationQueue';
export type { ExamPreparationStatus, ExamPreparationSummary } from './examPreparationStatus';
export type { DLQEntry } from './deadLetterQueue';
