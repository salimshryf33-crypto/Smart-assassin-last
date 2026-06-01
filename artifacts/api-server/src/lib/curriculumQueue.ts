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

export type JobStatus = 'queued' | 'processing' | 'done' | 'error';

export interface Job {
  id: string;
  docId: string;
  filePath: string;
  country: string;
  grade: string;
  subject: string;
  track: string;
  filename: string;
  status: JobStatus;
  progress: { current: number; total: number };
  result?: { totalPages: number; chunkCount: number; searchable: boolean };
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

// ─── Re-trigger indexing for an existing doc (e.g. after a failed job) ────────
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
  });

  logger.info({ jobId, docId: job.docId, filename: job.filename }, 'Processing curriculum PDF');

  try {
    // ── Stage 1: PDF extraction ─────────────────────────────────────────────
    const { pageTexts, totalPages } = await extractPdf(job.filePath, (current, total) => {
      job.progress = { current, total };
    });

    // ── Stage 2: Validate extraction ────────────────────────────────────────
    if (pageTexts.length === 0) {
      throw new Error(
        `PDF extraction produced 0 pages. The file may be image-based (scanned) ` +
        `with no text layer. totalPages reported by parser: ${totalPages}.`
      );
    }

    // ── Stage 3: Chunk generation ───────────────────────────────────────────
    const chunks: CurriculumChunk[] = chunkText(pageTexts, {
      docId: job.docId,
      country: job.country,
      grade: job.grade,
      subject: job.subject,
    });

    // ── Stage 4: Validate chunk count ───────────────────────────────────────
    if (chunks.length === 0) {
      throw new Error(
        `Chunking produced 0 chunks from ${pageTexts.length} pages. ` +
        `All pages may be empty or contain only whitespace.`
      );
    }

    const expectedMinChunks = Math.max(1, Math.floor(pageTexts.length / 20));
    if (chunks.length < expectedMinChunks) {
      logger.warn(
        { jobId, chunkCount: chunks.length, pageTexts: pageTexts.length, expectedMinChunks },
        'Unusually low chunk count — PDF may have sparse extractable text'
      );
    }

    // ── Stage 5: Save chunks + invalidate any stale in-memory state ─────────
    saveChunks(job.docId, chunks);
    invalidateChunkCache(job.docId);

    // ── Stage 6: Register doc as done in the index ──────────────────────────
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
    });

    // ── Stage 7: Verify searchability ───────────────────────────────────────
    // Use the same LEVEL_GRADE_MAP logic that searchChunks uses:
    // pass the grade directly and rely on the [gradeOrLevel] fallback.
    const verifyChunks = searchChunks(job.country, job.grade, job.subject, '', 1);
    const searchable = verifyChunks.length > 0;

    if (!searchable) {
      // This should never happen if save + upsert succeeded, but guard anyway.
      throw new Error(
        `Post-indexing searchability check failed: ` +
        `0 chunks returned for country=${job.country} grade=${job.grade} subject=${job.subject}. ` +
        `Chunks were saved (count=${chunks.length}) but search cannot find them.`
      );
    }

    job.status = 'done';
    job.result = { totalPages, chunkCount: chunks.length, searchable: true };
    job.progress = { current: totalPages, total: totalPages };

    logger.info(
      { jobId, totalPages, chunkCount: chunks.length, searchable: true },
      'Curriculum PDF processed and verified searchable'
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
    });
  } finally {
    // Clean up temp file
    try { if (fs.existsSync(job.filePath)) fs.unlinkSync(job.filePath); } catch { /* ignore */ }
    isProcessing = false;
    if (queue.length > 0) setImmediate(processNext);
  }
}
