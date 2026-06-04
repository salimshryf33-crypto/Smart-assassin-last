import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { logger } from './logger';
import {
  upsertDocMeta,
  saveChunks,
  searchChunks,
  invalidateChunkCache,
  type CurriculumChunk,
} from './curriculumStorage';
import { extractPdf } from './pdfExtractor';
import { chunkText } from './chunker';

export type JobStatus = 'queued' | 'processing' | 'ocr_running' | 'done' | 'error';

export interface Job {
  id: string;
  docId: string;
  filePath: string;
  country: string;
  grade: string;
  subject: string;
  track: string;
  filename: string;
  docType?: 'book' | 'note' | 'exam';
  status: JobStatus;
  progress: { current: number; total: number };
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

export function enqueueJob(data: Omit<Job, 'id' | 'status' | 'progress' | 'createdAt'>): string {
  const id = uuidv4();
  const job: Job = {
    ...data,
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

// ─── Re-trigger indexing for an existing doc ──────────────────────────────────
export async function reindexDoc(docId: string, filePath: string, meta: {
  country: string; grade: string; subject: string; track: string; filename: string;
}): Promise<Job> {
  const id = uuidv4();
  const job: Job = {
    id,
    docId,
    filePath,
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

async function processNext() {
  if (isProcessing || queue.length === 0) return;
  isProcessing = true;

  const jobId = queue.shift()!;
  const job = jobs.get(jobId);
  if (!job) { isProcessing = false; return; }

  job.status = 'processing';
  upsertDocMeta({
    id: job.docId,
    country: job.country,
    grade: job.grade,
    subject: job.subject,
    track: job.track,
    filename: job.filename,
    totalPages: 0,
    chunkCount: 0,
    status: 'processing',
    uploadedAt: job.createdAt,
    docType: job.docType,
  });

  logger.info({ jobId, docId: job.docId, filename: job.filename }, 'Processing curriculum PDF');

  try {
    // ── Stage 1: PDF extraction with quality validation ──────────────────────
    const extraction = await extractPdf(
      job.filePath,
      (current, total) => { job.progress = { current, total }; },
      // onOcrStart — fires when text extraction failed quality check and OCR begins
      () => {
        logger.info({ jobId, docId: job.docId }, 'Text extraction sparse — switching to OCR');
        job.status = 'ocr_running';
        upsertDocMeta({
          id: job.docId,
          country: job.country,
          grade: job.grade,
          subject: job.subject,
          track: job.track,
          filename: job.filename,
          totalPages: 0,
          chunkCount: 0,
          status: 'ocr_running',
          uploadedAt: job.createdAt,
          docType: job.docType,
        });
      }
    );

    const { pageTexts, totalPages, extractionMethod, quality } = extraction;

    logger.info(
      {
        jobId,
        extractionMethod,
        extractedPages: quality.pageCount,
        extractedChars: quality.totalChars,
        avgCharsPerPage: Math.round(quality.avgCharsPerPage),
        nonWsDensity: quality.nonWsDensity.toFixed(2),
        qualityPassed: quality.passed,
      },
      'PDF extraction complete'
    );

    // ── Stage 2: Validate extraction produced usable content ─────────────────
    if (pageTexts.length === 0) {
      throw new Error(
        `PDF extraction produced 0 usable pages after all stages (including OCR). ` +
        `File may be encrypted, blank, or the OCR service is unavailable. ` +
        `totalPages=${totalPages}, extractionMethod=${extractionMethod}`
      );
    }

    // ── Stage 3: Chunk generation ────────────────────────────────────────────
    const chunks: CurriculumChunk[] = chunkText(pageTexts, {
      docId: job.docId,
      country: job.country,
      grade: job.grade,
      subject: job.subject,
    });

    // ── Stage 4: Validate chunk count ────────────────────────────────────────
    if (chunks.length === 0) {
      throw new Error(
        `Chunking produced 0 chunks from ${pageTexts.length} pages (method=${extractionMethod}). ` +
        `All pages may be empty or contain only whitespace.`
      );
    }

    const expectedMinChunks = Math.max(1, Math.floor(pageTexts.length / 20));
    if (chunks.length < expectedMinChunks) {
      logger.warn(
        { jobId, chunkCount: chunks.length, pageCount: pageTexts.length, expectedMinChunks },
        'Unusually low chunk count after quality-validated extraction'
      );
    }

    // ── Stage 5: Save chunks + invalidate stale cache ────────────────────────
    saveChunks(job.docId, chunks);
    invalidateChunkCache(job.docId);

    // ── Stage 6: Register doc as done with full extraction metadata ──────────
    upsertDocMeta({
      id: job.docId,
      country: job.country,
      grade: job.grade,
      subject: job.subject,
      track: job.track,
      filename: job.filename,
      totalPages,
      chunkCount: chunks.length,
      status: 'done',
      uploadedAt: job.createdAt,
      processedAt: Date.now(),
      docType: job.docType,
      extractionMethod,
      extractedChars: quality.totalChars,
      avgCharsPerPage: Math.round(quality.avgCharsPerPage),
      extractedPages: quality.pageCount,
    });

    // ── Stage 7: Verify searchability ────────────────────────────────────────
    const verifyChunks = searchChunks(job.country, job.grade, job.subject, '', 1);
    const searchable = verifyChunks.length > 0;

    if (!searchable) {
      throw new Error(
        `Post-indexing searchability check failed: ` +
        `0 chunks returned for country=${job.country} grade=${job.grade} subject=${job.subject}. ` +
        `Chunks were saved (count=${chunks.length}) but search cannot find them.`
      );
    }

    job.status = 'done';
    job.result = {
      totalPages,
      chunkCount: chunks.length,
      searchable: true,
      extractionMethod,
      extractedChars: quality.totalChars,
      avgCharsPerPage: Math.round(quality.avgCharsPerPage),
    };
    job.progress = { current: totalPages, total: totalPages };

    logger.info(
      {
        jobId,
        totalPages,
        chunkCount: chunks.length,
        extractionMethod,
        extractedChars: quality.totalChars,
        avgCharsPerPage: Math.round(quality.avgCharsPerPage),
        searchable: true,
      },
      'Curriculum PDF processed, quality-validated, and verified searchable'
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ jobId, err: msg }, 'Failed to process curriculum PDF');

    job.status = 'error';
    job.error = msg;

    upsertDocMeta({
      id: job.docId,
      country: job.country,
      grade: job.grade,
      subject: job.subject,
      track: job.track,
      filename: job.filename,
      totalPages: 0,
      chunkCount: 0,
      status: 'error',
      errorMessage: msg,
      uploadedAt: job.createdAt,
      docType: job.docType,
    });
  } finally {
    try { if (fs.existsSync(job.filePath)) fs.unlinkSync(job.filePath); } catch { /* ignore */ }
    isProcessing = false;
    if (queue.length > 0) setImmediate(processNext);
  }
}
