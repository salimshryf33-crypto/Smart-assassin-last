import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { v4 as uuidv4 } from 'uuid';
import { enqueueJob, getJob, getAllJobs } from '../lib/curriculumQueue';
import { readIndex, deleteDoc, searchChunks, loadChunks, normalizeArabic, tokenize } from '../lib/curriculumStorage';

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
  limits: { fileSize: 150 * 1024 * 1024 }, // 150 MB
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

  const { country, grade, subject, track = '' } = req.body as Record<string, string>;
  if (!country || !grade || !subject) {
    fs.unlinkSync(req.file.path);
    res.status(400).json({ error: 'country, grade, and subject are required' });
    return;
  }

  const docId = uuidv4();
  const jobId = enqueueJob({
    docId,
    filePath: req.file.path,
    country,
    grade,
    subject,
    track,
    filename: req.file.originalname,
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
  })));
});

// GET /api/curriculum/docs
router.get('/docs', (_req, res) => {
  res.json(readIndex());
});

// DELETE /api/curriculum/docs/:id
router.delete('/docs/:id', (req, res) => {
  deleteDoc(req.params.id);
  req.log.info({ docId: req.params.id }, 'Deleted curriculum doc');
  res.json({ success: true });
});

// GET /api/curriculum/search?country=&grade=&subject=&query=&topK=
router.get('/search', (req, res) => {
  const { country, grade, subject, query = '', topK } = req.query as Record<string, string>;
  if (!country || !grade || !subject) {
    res.status(400).json({ error: 'country, grade, and subject are required' });
    return;
  }
  const chunks = searchChunks(country, grade, subject, query, topK ? parseInt(topK) : 5);
  res.json({ chunks, count: chunks.length });
});

// GET /api/curriculum/chunks/:docId  (for debugging/admin)
router.get('/chunks/:docId', (req, res) => {
  const chunks = loadChunks(req.params.docId);
  res.json({ chunks, count: chunks.length });
});

// GET /api/curriculum/debug/:docId?chunkIndex=N
// Shows raw + normalized content of a chunk with hex codes for invisible chars
router.get('/debug/:docId', (req, res) => {
  const { chunkIndex = '0', query = '' } = req.query as Record<string, string>;
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

export default router;
