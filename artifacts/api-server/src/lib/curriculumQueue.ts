import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { logger } from './logger';
import {
  upsertDocMeta,
  saveChunks,
  appendChunks,
  loadChunks,
  searchChunks,
  invalidateChunkCache,
  getDocMeta,
  getPdfPath,
  PDF_DIR,
  type CurriculumChunk,
  type CurriculumDocument,
} from './curriculumStorage';
import { extractPdf, QuotaExhaustedError } from './pdfExtractor';
import { chunkText } from './chunker';

export type JobStatus = 'queued' | 'processing' | 'ocr_running' | 'partial' | 'done' | 'error';

export interface Job {
  id: string;
  docId: string;
  // Path to the PDF file on disk. For new uploads this is the permanent storage
  // path (data/pdfs/<docId>.pdf). For resume jobs it is the same path.
  filePath: string;
  country: string;
  grade: string;
  subject: string;
  track: string;
  filename: string;
  docType?: 'book' | 'note' | 'exam';
  status: JobStatus;
  progress: { current: number; total: number };
  // For resume jobs: the 1-based PDF page to start OCR from.
  // Undefined (or 1) means start from the beginning.
  resumeFromPage?: number;
  // When true, newly generated chunks are appended to existing chunks rather
  // than overwriting them. Set automatically for resume jobs.
  appendMode?: boolean;
  result?: {
    totalPages: number;
    chunkCount: number;
    searchable: boolean;
    extractionMethod: 'text' | 'virtual' | 'ocr';
    extractedChars: number;
    avgCharsPerPage: number;
  };
  error?: string;
  createdAt: number;
}

const jobs = new Map<string, Job>();
const queue: string[] = [];
let isProcessing = false;

// ─── Enqueue a new upload job ─────────────────────────────────────────────────
//
// The uploaded PDF is copied to permanent storage (data/pdfs/<docId>.pdf)
// before the tmp file is deleted. The job's filePath always points to the
// permanent copy so the file survives across server restarts.

export function enqueueJob(data: Omit<Job, 'id' | 'status' | 'progress' | 'createdAt'> & {
  tmpFilePath: string;
}): string {
  const id = uuidv4();
  const { tmpFilePath, ...rest } = data;

  // Copy uploaded PDF to permanent storage
  const permanentPath = getPdfPath(data.docId);
  fs.mkdirSync(PDF_DIR, { recursive: true });
  fs.copyFileSync(tmpFilePath, permanentPath);
  // Remove the multer tmp file
  try { fs.unlinkSync(tmpFilePath); } catch { /* ignore */ }

  const job: Job = {
    ...rest,
    filePath: permanentPath,
    id,
    status: 'queued',
    progress: { current: 0, total: 0 },
    createdAt: Date.now(),
  };
  jobs.set(id, job);
  queue.push(id);

  upsertDocMeta({
    id: data.docId,
    country: data.country,
    grade: data.grade,
    subject: data.subject,
    track: data.track,
    filename: data.filename,
    totalPages: 0,
    chunkCount: 0,
    status: 'queued',
    uploadedAt: Date.now(),
    docType: data.docType,
    pdfStoragePath: permanentPath,
  });

  setImmediate(processNext);
  return id;
}

export function getJob(id: string): Job | null {
  return jobs.get(id) ?? null;
}

export function getAllJobs(): Job[] {
  return Array.from(jobs.values()).sort((a, b) => b.createdAt - a.createdAt);
}

// ─── Re-index an existing doc with a newly uploaded PDF ──────────────────────
//
// If a new PDF is provided, it replaces the stored copy.
// This is a full re-index (startFromPage=1, overwrites existing chunks).

export async function reindexDoc(docId: string, newFilePath: string, meta: {
  country: string; grade: string; subject: string; track: string; filename: string;
}): Promise<Job> {
  const permanentPath = getPdfPath(docId);
  fs.mkdirSync(PDF_DIR, { recursive: true });

  if (newFilePath !== permanentPath) {
    fs.copyFileSync(newFilePath, permanentPath);
    try { fs.unlinkSync(newFilePath); } catch { /* ignore */ }
  }

  const id = uuidv4();
  const job: Job = {
    id,
    docId,
    filePath: permanentPath,
    ...meta,
    status: 'queued',
    progress: { current: 0, total: 0 },
    createdAt: Date.now(),
  };
  jobs.set(id, job);
  queue.push(id);
  setImmediate(processNext);
  return job;
}

// ─── Resume OCR from last saved page ─────────────────────────────────────────
//
// Requirements:
//   • doc.status must be 'partial' or 'error' (with lastRenderedPage set)
//   • doc.pdfStoragePath must exist on disk
//
// The resume job starts OCR from (doc.lastRenderedPage + 1), appends new
// chunks to the existing chunk file, and transitions the doc to 'done'
// if OCR reaches the last page.

export async function resumeDoc(docId: string): Promise<Job> {
  const doc = getDocMeta(docId);
  if (!doc) {
    throw new Error(`Document ${docId} not found in index`);
  }

  const resumableStatuses: CurriculumDocument['status'][] = ['partial', 'error'];
  if (!resumableStatuses.includes(doc.status)) {
    throw new Error(
      `Document ${docId} has status '${doc.status}' — only 'partial' or 'error' documents can be resumed`
    );
  }

  const pdfPath = doc.pdfStoragePath ?? getPdfPath(docId);
  if (!fs.existsSync(pdfPath)) {
    throw new Error(
      `PDF file not found at '${pdfPath}'. ` +
      `The original PDF must be present for resume. ` +
      `Use POST /api/curriculum/reindex/${docId} to upload a new copy.`
    );
  }

  // Resume from the page after the last successfully rendered page.
  // If lastRenderedPage is not set (older partial docs), restart from page 1.
  const resumeFromPage = (doc.lastRenderedPage ?? 0) + 1;

  logger.info(
    { docId, resumeFromPage, lastRenderedPage: doc.lastRenderedPage, pdfPath },
    'Resuming OCR from last saved page'
  );

  const id = uuidv4();
  const job: Job = {
    id,
    docId,
    filePath: pdfPath,
    country: doc.country,
    grade: doc.grade,
    subject: doc.subject,
    track: doc.track,
    filename: doc.filename,
    docType: doc.docType,
    status: 'queued',
    progress: { current: resumeFromPage - 1, total: doc.totalPages },
    resumeFromPage,
    appendMode: true,
    createdAt: Date.now(),
  };
  jobs.set(id, job);
  queue.push(id);
  setImmediate(processNext);
  return job;
}

// ─── Core processor ──────────────────────────────────────────────────────────

async function processNext() {
  if (isProcessing || queue.length === 0) return;
  isProcessing = true;

  const jobId = queue.shift()!;
  const job = jobs.get(jobId);
  if (!job) { isProcessing = false; return; }

  const isResume = Boolean(job.resumeFromPage && job.resumeFromPage > 1);
  const startFromPage = job.resumeFromPage ?? 1;

  // Read existing doc meta so we can merge fields on partial saves
  const existingMeta = getDocMeta(job.docId);

  job.status = 'processing';
  upsertDocMeta({
    ...(existingMeta ?? {}),
    id: job.docId,
    country: job.country,
    grade: job.grade,
    subject: job.subject,
    track: job.track,
    filename: job.filename,
    totalPages: existingMeta?.totalPages ?? 0,
    chunkCount: existingMeta?.chunkCount ?? 0,
    status: 'processing',
    uploadedAt: existingMeta?.uploadedAt ?? job.createdAt,
    docType: job.docType,
    pdfStoragePath: job.filePath,
    lastRenderedPage: existingMeta?.lastRenderedPage,
  });

  logger.info({ jobId, docId: job.docId, filename: job.filename, isResume, startFromPage }, 'Processing curriculum PDF');

  try {
    // ── PDF extraction ───────────────────────────────────────────────────────
    const extraction = await extractPdf(
      job.filePath,
      // Progress callback
      (current, total) => { job.progress = { current, total }; },
      // onOcrStart — fires when text layers fail and image OCR begins
      () => {
        logger.info({ jobId, docId: job.docId }, 'Text extraction sparse — switching to OCR');
        job.status = 'ocr_running';
        upsertDocMeta({
          ...(getDocMeta(job.docId) ?? {}),
          id: job.docId,
          country: job.country,
          grade: job.grade,
          subject: job.subject,
          track: job.track,
          filename: job.filename,
          totalPages: 0,
          chunkCount: existingMeta?.chunkCount ?? 0,
          status: 'ocr_running',
          uploadedAt: existingMeta?.uploadedAt ?? job.createdAt,
          docType: job.docType,
          pdfStoragePath: job.filePath,
          lastRenderedPage: existingMeta?.lastRenderedPage,
        });
      },
      // startFromPage — 1 for new jobs, >1 for resume jobs
      startFromPage,
      // onBatchComplete — persist the resume point after every batch
      // so a quota failure mid-book always leaves a recoverable state
      (lastRenderedPage: number) => {
        const current = getDocMeta(job.docId);
        upsertDocMeta({
          ...(current ?? {}),
          id: job.docId,
          country: job.country,
          grade: job.grade,
          subject: job.subject,
          track: job.track,
          filename: job.filename,
          totalPages: current?.totalPages ?? 0,
          chunkCount: current?.chunkCount ?? 0,
          status: 'ocr_running',
          uploadedAt: current?.uploadedAt ?? job.createdAt,
          docType: job.docType,
          pdfStoragePath: job.filePath,
          lastRenderedPage,
        });
        logger.info({ jobId, docId: job.docId, lastRenderedPage }, 'OCR batch checkpoint saved');
      },
    );

    const { pageTexts, totalPages, extractionMethod, quality, lastRenderedPage } = extraction;

    logger.info(
      {
        jobId,
        extractionMethod,
        extractedPages: quality.pageCount,
        extractedChars: quality.totalChars,
        avgCharsPerPage: Math.round(quality.avgCharsPerPage),
        nonWsDensity: quality.nonWsDensity.toFixed(2),
        qualityPassed: quality.passed,
        lastRenderedPage,
      },
      'PDF extraction complete'
    );

    if (pageTexts.length === 0) {
      throw new Error(
        `PDF extraction produced 0 usable pages after all stages (including OCR). ` +
        `File may be encrypted, blank, or the OCR service is unavailable. ` +
        `totalPages=${totalPages}, extractionMethod=${extractionMethod}`
      );
    }

    // ── Chunk generation ─────────────────────────────────────────────────────
    const newChunks: CurriculumChunk[] = chunkText(pageTexts, {
      docId: job.docId,
      country: job.country,
      grade: job.grade,
      subject: job.subject,
    });

    if (newChunks.length === 0) {
      throw new Error(
        `Chunking produced 0 chunks from ${pageTexts.length} pages (method=${extractionMethod}). ` +
        `All pages may be empty or contain only whitespace.`
      );
    }

    const expectedMinChunks = Math.max(1, Math.floor(pageTexts.length / 20));
    if (newChunks.length < expectedMinChunks) {
      logger.warn(
        { jobId, chunkCount: newChunks.length, pageCount: pageTexts.length, expectedMinChunks },
        'Unusually low chunk count after quality-validated extraction'
      );
    }

    // ── Save chunks (append on resume, overwrite on fresh job) ───────────────
    if (job.appendMode) {
      appendChunks(job.docId, newChunks);
    } else {
      saveChunks(job.docId, newChunks);
    }
    invalidateChunkCache(job.docId);

    // ── Compute final chunk count (existing + new for resume jobs) ───────────
    const finalChunks = loadChunks(job.docId);
    const finalChunkCount = finalChunks.length;

    // ── Final total pages (merge existing page count for resume) ─────────────
    const prevTotalPages = existingMeta?.totalPages ?? 0;
    const finalTotalPages = Math.max(totalPages, prevTotalPages);

    // ── Register doc as done ─────────────────────────────────────────────────
    upsertDocMeta({
      id: job.docId,
      country: job.country,
      grade: job.grade,
      subject: job.subject,
      track: job.track,
      filename: job.filename,
      totalPages: finalTotalPages,
      chunkCount: finalChunkCount,
      status: 'done',
      uploadedAt: existingMeta?.uploadedAt ?? job.createdAt,
      processedAt: Date.now(),
      docType: job.docType,
      extractionMethod,
      extractedChars: quality.totalChars + (existingMeta?.extractedChars ?? 0),
      avgCharsPerPage: Math.round(quality.avgCharsPerPage),
      extractedPages: quality.pageCount + (existingMeta?.extractedPages ?? 0),
      pdfStoragePath: job.filePath,
      lastRenderedPage: lastRenderedPage ?? finalTotalPages,
    });

    // ── Verify searchability ─────────────────────────────────────────────────
    const verifyChunks = searchChunks(job.country, job.grade, job.subject, '', 1);
    const searchable = verifyChunks.length > 0;

    if (!searchable) {
      throw new Error(
        `Post-indexing searchability check failed: ` +
        `0 chunks returned for country=${job.country} grade=${job.grade} subject=${job.subject}. ` +
        `Chunks were saved (count=${finalChunkCount}) but search cannot find them.`
      );
    }

    job.status = 'done';
    job.result = {
      totalPages: finalTotalPages,
      chunkCount: finalChunkCount,
      searchable: true,
      extractionMethod,
      extractedChars: quality.totalChars,
      avgCharsPerPage: Math.round(quality.avgCharsPerPage),
    };
    job.progress = { current: finalTotalPages, total: finalTotalPages };

    logger.info(
      {
        jobId,
        totalPages: finalTotalPages,
        chunkCount: finalChunkCount,
        extractionMethod,
        extractedChars: quality.totalChars,
        avgCharsPerPage: Math.round(quality.avgCharsPerPage),
        searchable: true,
        isResume,
      },
      'Curriculum PDF processed, quality-validated, and verified searchable'
    );

  } catch (err) {
    // ── Quota exhausted: save partial progress ────────────────────────────────
    if (err instanceof QuotaExhaustedError) {
      logger.warn(
        { jobId, docId: job.docId, lastRenderedPage: err.lastRenderedPage, accumulatedBatches: err.accumulatedTexts.length },
        'Gemini quota exhausted — saving partial OCR progress'
      );

      // If we have accumulated text from successful batches, chunk and save it
      if (err.accumulatedTexts.length > 0) {
        try {
          // Re-split accumulated OCR blobs into virtual pages for the chunker
          const partialPages: string[] = err.accumulatedTexts.flatMap((blob) => {
            const pages: string[] = [];
            const VSIZE = 2000;
            for (let i = 0; i < blob.length; i += VSIZE) {
              let end = Math.min(i + VSIZE, blob.length);
              if (end < blob.length) {
                const sp = blob.lastIndexOf(' ', end);
                if (sp > i + VSIZE / 2) end = sp + 1;
              }
              const slice = blob.slice(i, end).trim();
              if (slice.length >= 10) pages.push(slice);
            }
            return pages;
          });

          const partialChunks: CurriculumChunk[] = chunkText(
            partialPages,
            {
              docId: job.docId,
              country: job.country,
              grade: job.grade,
              subject: job.subject,
            }
          );

          if (job.appendMode) {
            appendChunks(job.docId, partialChunks);
          } else {
            saveChunks(job.docId, partialChunks);
          }
          invalidateChunkCache(job.docId);

          const savedChunks = loadChunks(job.docId);

          upsertDocMeta({
            ...(getDocMeta(job.docId) ?? {}),
            id: job.docId,
            country: job.country,
            grade: job.grade,
            subject: job.subject,
            track: job.track,
            filename: job.filename,
            totalPages: existingMeta?.totalPages ?? 0,
            chunkCount: savedChunks.length,
            status: 'partial',
            uploadedAt: existingMeta?.uploadedAt ?? job.createdAt,
            docType: job.docType,
            extractionMethod: 'ocr',
            extractedChars: (existingMeta?.extractedChars ?? 0) + err.accumulatedTexts.reduce((s, t) => s + t.length, 0),
            extractedPages: existingMeta?.extractedPages ?? 0,
            pdfStoragePath: job.filePath,
            lastRenderedPage: err.lastRenderedPage,
          });

          job.status = 'partial';
          job.error = `Gemini quota exhausted at page ${err.lastRenderedPage}. Resume with POST /api/curriculum/docs/${job.docId}/resume`;

          logger.info(
            { jobId, docId: job.docId, chunksSaved: savedChunks.length, lastRenderedPage: err.lastRenderedPage },
            'Partial OCR progress saved — document is resumable'
          );
        } catch (saveErr) {
          logger.error({ jobId, err: String(saveErr) }, 'Failed to save partial OCR progress');
          job.status = 'error';
          job.error = `Quota exhausted and failed to save partial progress: ${String(saveErr)}`;
        }
      } else {
        // No batches completed before quota hit
        upsertDocMeta({
          ...(getDocMeta(job.docId) ?? {}),
          id: job.docId,
          country: job.country,
          grade: job.grade,
          subject: job.subject,
          track: job.track,
          filename: job.filename,
          totalPages: existingMeta?.totalPages ?? 0,
          chunkCount: existingMeta?.chunkCount ?? 0,
          status: 'partial',
          uploadedAt: existingMeta?.uploadedAt ?? job.createdAt,
          docType: job.docType,
          pdfStoragePath: job.filePath,
          lastRenderedPage: err.lastRenderedPage,
        });
        job.status = 'partial';
        job.error = `Gemini quota exhausted before any batches completed (lastRenderedPage=${err.lastRenderedPage}). Resume with POST /api/curriculum/docs/${job.docId}/resume`;
      }
    } else {
      // ── Other errors: mark as error ───────────────────────────────────────
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ jobId, err: msg }, 'Failed to process curriculum PDF');

      job.status = 'error';
      job.error = msg;

      upsertDocMeta({
        ...(getDocMeta(job.docId) ?? {}),
        id: job.docId,
        country: job.country,
        grade: job.grade,
        subject: job.subject,
        track: job.track,
        filename: job.filename,
        totalPages: existingMeta?.totalPages ?? 0,
        chunkCount: existingMeta?.chunkCount ?? 0,
        status: 'error',
        errorMessage: msg,
        uploadedAt: existingMeta?.uploadedAt ?? job.createdAt,
        docType: job.docType,
        pdfStoragePath: job.filePath,
        lastRenderedPage: existingMeta?.lastRenderedPage,
      });
    }
  } finally {
    // ── IMPORTANT: Never delete the permanent PDF ─────────────────────────────
    // job.filePath points to data/pdfs/<docId>.pdf — this is permanent storage.
    // The file is only removed when the document is explicitly deleted via the
    // DELETE /api/curriculum/docs/:id endpoint (which calls deleteDoc()).
    isProcessing = false;
    if (queue.length > 0) setImmediate(processNext);
  }
}
