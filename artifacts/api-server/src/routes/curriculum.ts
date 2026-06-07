import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { v4 as uuidv4 } from 'uuid';
import { enqueueJob, getJob, getAllJobs, reindexDoc, resumeDoc } from '../lib/curriculumQueue';
import {
  readIndex,
  deleteDoc,
  searchChunks,
  loadChunks,
  normalizeArabic,
  tokenize,
  invalidateChunkCache,
  getDocMeta,
  getPdfPath,
} from '../lib/curriculumStorage';

const TMP_DIR = path.join(process.cwd(), 'data', 'tmp');
fs.mkdirSync(TMP_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, TMP_DIR),
    filename: (_req, file, cb) => {
      const safe = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
      cb(null, `${Date.now()}-${safe}`);
    },
  }),
  limits: { fileSize: 150 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Only PDF files are allowed'));
  },
});

const router = Router();

// POST /api/curriculum/upload
router.post('/upload', upload.single('pdf'), (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'No PDF file uploaded' });
    return;
  }

  const { country, grade, subject, track = '', docType = 'book' } = req.body as Record<string, string>;
  if (!country || !grade || !subject) {
    fs.unlinkSync(req.file.path);
    res.status(400).json({ error: 'country, grade, and subject are required' });
    return;
  }

  const validDocType = ['book', 'note', 'exam'].includes(docType) ? docType as 'book' | 'note' | 'exam' : 'book';

  const docId = uuidv4();
  const jobId = enqueueJob({
    docId,
    tmpFilePath: req.file.path,
    filePath: '',          // set by enqueueJob after copying to permanent storage
    country,
    grade,
    subject,
    track,
    filename: req.file.originalname,
    docType: validDocType,
  });

  req.log.info({ jobId, docId, filename: req.file.originalname }, 'Curriculum upload queued');
  res.status(202).json({ jobId, docId, status: 'queued' });
});

// GET /api/curriculum/jobs/:jobId
router.get('/jobs/:jobId', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }
  res.json({
    jobId: job.id,
    docId: job.docId,
    status: job.status,
    progress: job.progress,
    result: job.result,
    error: job.error,
    resumeFromPage: job.resumeFromPage,
  });
});

// GET /api/curriculum/jobs
router.get('/jobs', (_req, res) => {
  res.json(getAllJobs().map((j) => ({
    jobId: j.id,
    docId: j.docId,
    filename: j.filename,
    status: j.status,
    progress: j.progress,
    result: j.result,
    error: j.error,
    resumeFromPage: j.resumeFromPage,
  })));
});

// GET /api/curriculum/docs
router.get('/docs', (_req, res) => {
  res.json(readIndex());
});

// DELETE /api/curriculum/docs/:id
// Deletes the index entry, chunk file, AND the permanently stored PDF.
router.delete('/docs/:id', (req, res) => {
  deleteDoc(req.params.id);
  req.log.info({ docId: req.params.id }, 'Deleted curriculum doc');
  res.json({ success: true });
});

// POST /api/curriculum/docs/:docId/resume
// Resume OCR for a 'partial' document from its last saved page.
// The original PDF must be present in permanent storage (data/pdfs/<docId>.pdf).
// No file upload required — uses the stored copy from the original upload.
router.post('/docs/:docId/resume', async (req, res) => {
  const { docId } = req.params;

  const doc = getDocMeta(docId);
  if (!doc) {
    res.status(404).json({ error: `Document ${docId} not found in index` });
    return;
  }

  if (doc.status !== 'partial' && doc.status !== 'error') {
    res.status(400).json({
      error: `Document status is '${doc.status}' — only 'partial' or 'error' documents can be resumed`,
      currentStatus: doc.status,
      lastRenderedPage: doc.lastRenderedPage,
    });
    return;
  }

  const pdfPath = doc.pdfStoragePath ?? getPdfPath(docId);
  if (!fs.existsSync(pdfPath)) {
    res.status(409).json({
      error: 'PDF file not found in permanent storage. Re-upload the file using POST /api/curriculum/reindex/:id',
      pdfPath,
    });
    return;
  }

  try {
    const job = await resumeDoc(docId);
    req.log.info(
      { jobId: job.id, docId, resumeFromPage: job.resumeFromPage },
      'OCR resume queued'
    );
    res.status(202).json({
      jobId: job.id,
      docId,
      status: 'queued',
      resumeFromPage: job.resumeFromPage,
      message: `Resuming OCR from page ${job.resumeFromPage} (last completed: ${doc.lastRenderedPage ?? 0})`,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// POST /api/curriculum/reindex/:id
// Full re-index: requires a PDF upload, replaces the stored copy and all chunks.
// If the document is partial/done, the existing chunks will be overwritten.
router.post('/reindex/:id', upload.single('pdf'), async (req, res) => {
  const docId = req.params['id'] as string;
  const existing = getDocMeta(docId);

  if (!existing) {
    if (req.file) fs.unlinkSync(req.file.path);
    res.status(404).json({ error: 'Document not found in index' });
    return;
  }

  if (!req.file) {
    // If no new PDF provided, check if we have the stored copy
    const storedPath = existing.pdfStoragePath ?? getPdfPath(docId);
    if (!fs.existsSync(storedPath)) {
      res.status(400).json({
        error: 'No PDF file uploaded and no stored copy found. Please upload the PDF.',
      });
      return;
    }

    // Re-index from stored copy
    invalidateChunkCache(docId);
    const job = await reindexDoc(docId, storedPath, {
      country: existing.country,
      grade: existing.grade,
      subject: existing.subject,
      track: existing.track,
      filename: existing.filename,
    });
    res.status(202).json({ jobId: job.id, docId, status: 'queued', source: 'stored_pdf' });
    return;
  }

  req.log.info({ docId, filename: req.file.originalname }, 'Reindex with new PDF requested');
  invalidateChunkCache(docId);

  const job = await reindexDoc(docId, req.file.path, {
    country: existing.country,
    grade: existing.grade,
    subject: existing.subject,
    track: existing.track,
    filename: req.file.originalname || existing.filename,
  });

  res.status(202).json({ jobId: job.id, docId, status: 'queued', source: 'new_upload' });
});

// GET /api/curriculum/search?country=&grade=&subject=&query=&topK=
router.get('/search', (req, res) => {
  const { country, grade, subject, query = '', topK } = req.query as Record<string, string>;
  if (!country || !grade || !subject) {
    res.status(400).json({ error: 'country, grade, and subject are required' });
    return;
  }
  invalidateChunkCache();
  const chunks = searchChunks(country, grade, subject, query, topK ? parseInt(topK) : 5);
  res.json({ chunks, count: chunks.length });
});

// GET /api/curriculum/chunks/:docId
router.get('/chunks/:docId', (req, res) => {
  invalidateChunkCache(req.params.docId);
  const chunks = loadChunks(req.params.docId);
  res.json({ chunks, count: chunks.length });
});

// GET /api/curriculum/debug/:docId?chunkIndex=N
router.get('/debug/:docId', (req, res) => {
  const { chunkIndex = '0', query = '' } = req.query as Record<string, string>;
  invalidateChunkCache(req.params.docId);
  const chunks = loadChunks(req.params.docId);
  if (chunks.length === 0) {
    res.status(404).json({ error: 'No chunks found' });
    return;
  }
  const idx = Math.min(parseInt(chunkIndex), chunks.length - 1);
  const chunk = chunks[idx];

  const raw200 = chunk.content.slice(0, 200);
  const hexCodes = Array.from(raw200).map((ch) => {
    const cp = ch.codePointAt(0)!;
    return cp > 0x007e || cp < 0x0020 ? `[U+${cp.toString(16).padStart(4, '0')}]` : ch;
  }).join('');

  const normalized = normalizeArabic(chunk.content);
  const tokens = tokenize(chunk.content).slice(0, 20);

  const queryInfo = query ? {
    queryNorm: normalizeArabic(query),
    queryTokens: tokenize(query),
    substringMatch: normalized.includes(normalizeArabic(query)),
  } : undefined;

  res.json({
    chunkIndex: idx,
    totalChunks: chunks.length,
    pageRange: chunk.pageRange,
    chapter: chunk.chapter,
    rawPreview: raw200,
    hexCodes,
    normalizedPreview: normalized.slice(0, 300),
    hasContentNormalized: 'contentNormalized' in chunk,
    keywords: chunk.keywords.slice(0, 15),
    tokens,
    queryInfo,
  });
});

// GET /api/curriculum/verify/:id
router.get('/verify/:id', (req, res) => {
  const doc = getDocMeta(req.params.id);
  if (!doc) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }

  invalidateChunkCache(doc.id);
  const chunks = loadChunks(doc.id);

  // partial docs are searchable for their completed pages
  if (doc.status !== 'done' && doc.status !== 'partial') {
    res.json({ searchable: false, reason: `Status is '${doc.status}'`, chunkCount: 0, doc });
    return;
  }

  if (chunks.length === 0) {
    res.json({ searchable: false, reason: 'No chunks on disk', chunkCount: 0, doc });
    return;
  }

  const results = searchChunks(doc.country, doc.grade, doc.subject, '', 1);
  const searchable = results.length > 0;

  res.json({
    searchable,
    reason: searchable
      ? doc.status === 'partial'
        ? `Partial document is searchable (pages 1–${doc.lastRenderedPage ?? '?'} of ${doc.totalPages}). Resume OCR with POST /api/curriculum/docs/${doc.id}/resume`
        : 'Document is live in search index'
      : 'Search returned 0 results despite chunks existing',
    chunkCount: chunks.length,
    resumable: doc.status === 'partial',
    doc,
  });
});

export default router;
