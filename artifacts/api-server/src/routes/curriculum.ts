import { Router } from 'express';
import * as cache from '../services/cacheService';
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
import { requireAuth, requireAdmin, isAdmin } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimiter';
import { computeUploadVisibility } from '../lib/visibilityRules';
import { audit } from '../lib/auditLog';
import { validatePdf, recordPdfHash } from '../lib/pdfValidator';

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

/** Safely coerce Express's `string | string[]` param value to a single string. */
const str = (v: string | string[] | undefined): string =>
  Array.isArray(v) ? v[0] ?? '' : v ?? '';

/**
 * Re-decode a string that was read as Latin-1 but whose underlying bytes are UTF-8.
 * Multer/busboy reads multipart field values and filenames as Latin-1 by default,
 * so Arabic (and other non-ASCII) text arrives as mojibake that needs this fix.
 * ASCII-only strings pass through unchanged.
 */
function fixEncoding(s: string): string {
  if (!s) return s;
  // Only attempt re-decode if the string contains high-Latin-1 bytes (≥ 0xC0),
  // which are the leading bytes of multi-byte UTF-8 sequences for Arabic etc.
  if (!/[\xC0-\xFF]/.test(s)) return s;
  try {
    return Buffer.from(s, 'latin1').toString('utf8');
  } catch {
    return s;
  }
}

// ─── GET /api/curriculum/me ───────────────────────────────────────────────────
// Returns the caller's UID and admin flag.  Used by the frontend to adapt UI.
router.get('/me', requireAuth, (req, res) => {
  res.json({ uid: req.user!.uid, isAdmin: isAdmin(req.user!) });
});

// ─── POST /api/curriculum/upload ─────────────────────────────────────────────
// Books   → admin only   (visibility = public, ownerId = null)
// Notes   → any user     (visibility = private, ownerId = uid)
// Exams   → any user     (visibility = private, ownerId = uid)
router.post('/upload', requireAuth, rateLimit('pdf_upload'), upload.single('pdf'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'No PDF file uploaded' });
    return;
  }

  const {
    country, grade, subject,
    track = '',
    docType = 'book',
    bookTitle: rawBookTitle = '',
  } = req.body as Record<string, string>;

  // Re-decode form fields and filename from Latin-1 → UTF-8 (multer/busboy default).
  const bookTitle = fixEncoding(rawBookTitle);

  if (!country || !grade || !subject) {
    fs.unlinkSync(req.file.path);
    res.status(400).json({ error: 'country, grade, and subject are required' });
    return;
  }

  const validDocType =
    ['book', 'note', 'exam'].includes(docType)
      ? (docType as 'book' | 'note' | 'exam')
      : 'book';

  const caller      = req.user!;
  const adminCaller = isAdmin(caller);

  // Only admins can upload curriculum books
  if (validDocType === 'book' && !adminCaller) {
    fs.unlinkSync(req.file.path);
    res.status(403).json({ error: 'Admin access required to upload curriculum books' });
    return;
  }

  // Visibility is computed by the canonical rule in visibilityRules.ts
  // (tested independently — single source of truth for the whole server).
  const { visibility, ownerId } = computeUploadVisibility(validDocType, adminCaller, caller.uid);

  // ── Feature 2: PDF Security Validation ──────────────────────────────────────
  const pdfCheck = await validatePdf(req.file.path, { ownerId });
  if (!pdfCheck.valid) {
    fs.unlinkSync(req.file.path);
    res.status(400).json({ error: pdfCheck.reason ?? 'Invalid PDF file', code: 'INVALID_PDF' });
    return;
  }

  const originalname = fixEncoding(req.file.originalname);

  // Derive bookTitle: use provided value or filename stem
  const resolvedTitle =
    bookTitle.trim() ||
    originalname.replace(/\.pdf$/i, '').trim() ||
    originalname;

  // ── Duplicate protection for public books ──────────────────────────────────
  if (validDocType === 'book') {
    const duplicate = readIndex().find(
      (d) =>
        d.docType === 'book' &&
        d.visibility === 'public' &&
        d.country  === country &&
        d.grade    === grade &&
        d.subject  === subject &&
        d.bookTitle === resolvedTitle
    );
    if (duplicate) {
      fs.unlinkSync(req.file.path);
      res.status(409).json({
        error: `A book titled "${resolvedTitle}" already exists for this subject.`,
        existingDocId: duplicate.id,
        hint: 'Use POST /api/curriculum/reindex/:id to update it.',
      });
      return;
    }
  }

  const docId = uuidv4();
  const jobId = enqueueJob({
    docId,
    tmpFilePath: req.file.path,
    filePath: '',
    country,
    grade,
    subject,
    track,
    filename: originalname,
    docType: validDocType,
    ownerId,
    visibility,
    bookTitle: resolvedTitle,
  });

  // Record PDF hash for future duplicate detection (fire-and-forget)
  if (pdfCheck.sha256) {
    recordPdfHash(pdfCheck.sha256, docId, ownerId).catch(() => {});
  }

  req.log.info(
    {
      jobId, docId, filename: originalname, docType: validDocType,
      visibility, bookTitle: resolvedTitle, sizeKB: pdfCheck.sizeKB,
    },
    'Curriculum upload queued'
  );

  // Audit trail — fire-and-forget
  audit({
    uid:          caller.uid,
    action:       'pdf_upload',
    resourceType: 'curriculum_doc',
    resourceId:   docId,
    metadata:     { filename: originalname, docType: validDocType, visibility, sizeKB: pdfCheck.sizeKB },
    req,
  });

  // Invalidate search cache for this subject — new content makes old results stale.
  cache.invalidateSubjectSearch(country, grade, subject).catch(() => undefined);

  res.status(202).json({ jobId, docId, status: 'queued' });
});

// ─── GET /api/curriculum/jobs ─────────────────────────────────────────────────
// Admin only — full job list.
router.get('/jobs', requireAuth, requireAdmin, (_req, res) => {
  res.json(
    getAllJobs().map((j) => ({
      jobId: j.id,
      docId: j.docId,
      filename: j.filename,
      status: j.status,
      progress: j.progress,
      result: j.result,
      error: j.error,
      resumeFromPage: j.resumeFromPage,
    }))
  );
});

// ─── GET /api/curriculum/jobs/:jobId ─────────────────────────────────────────
// Any authenticated user can poll their own job.
router.get('/jobs/:jobId', requireAuth, (req, res) => {
  const job = getJob(str(req.params.jobId));
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

// ─── GET /api/curriculum/docs ─────────────────────────────────────────────────
// Returns: all public docs + caller's own private docs.
router.get('/docs', requireAuth, (req, res) => {
  const uid  = req.user!.uid;
  const docs = readIndex().filter(
    (d) => d.visibility !== 'private' || d.ownerId === uid
  );
  res.json(docs);
});

// ─── DELETE /api/curriculum/docs/:id ─────────────────────────────────────────
// Admin: delete any doc.  User: delete only their own private docs.
router.delete('/docs/:id', requireAuth, (req, res) => {
  const docId = str(req.params.id);
  const doc   = getDocMeta(docId);
  const user  = req.user!;

  if (!doc) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }

  const canDelete =
    isAdmin(user) ||
    (doc.visibility === 'private' && doc.ownerId === user.uid);

  if (!canDelete) {
    res.status(403).json({ error: 'You do not have permission to delete this document' });
    return;
  }

  deleteDoc(docId);
  // Invalidate search cache for the deleted doc's subject.
  cache.invalidateSubjectSearch(doc.country, doc.grade, doc.subject).catch(() => undefined);
  req.log.info({ docId, deletedBy: user.uid }, 'Deleted curriculum doc');
  // Audit trail — fire-and-forget
  audit({
    uid:          user.uid,
    action:       'doc_delete',
    resourceType: 'curriculum_doc',
    resourceId:   docId,
    metadata:     { filename: doc.filename, docType: doc.docType, visibility: doc.visibility },
    req,
  });
  res.json({ success: true });
});

// ─── POST /api/curriculum/docs/:docId/resume ─────────────────────────────────
// Admin only — resume OCR for partial docs.
router.post('/docs/:docId/resume', requireAuth, requireAdmin, async (req, res) => {
  const docId = str(req.params.docId);
  const doc   = getDocMeta(docId);

  if (!doc) {
    res.status(404).json({ error: `Document ${docId} not found` });
    return;
  }
  if (doc.status !== 'partial' && doc.status !== 'error') {
    res.status(400).json({
      error: `Status is '${doc.status}' — only 'partial' or 'error' docs can be resumed`,
      currentStatus: doc.status,
    });
    return;
  }

  const pdfPath = doc.pdfStoragePath ?? getPdfPath(docId);
  if (!fs.existsSync(pdfPath)) {
    res.status(409).json({
      error: 'PDF not found in permanent storage. Re-upload via POST /api/curriculum/reindex/:id',
      pdfPath,
    });
    return;
  }

  try {
    const job = await resumeDoc(docId);
    // Invalidate search cache — resumed OCR will produce new/updated chunks.
    cache.invalidateSubjectSearch(doc.country, doc.grade, doc.subject).catch(() => undefined);
    req.log.info(
      { jobId: job.id, docId, resumeFromPage: job.resumeFromPage },
      'OCR resume queued'
    );
    res.status(202).json({
      jobId: job.id,
      docId,
      status: 'queued',
      resumeFromPage: job.resumeFromPage,
      message: `Resuming OCR from page ${job.resumeFromPage} (last: ${doc.lastRenderedPage ?? 0})`,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ─── POST /api/curriculum/reindex/:id ────────────────────────────────────────
// Admin only — full re-index with optional new PDF.
router.post('/reindex/:id', requireAuth, requireAdmin, upload.single('pdf'), async (req, res) => {
  const docId    = str(req.params.id);
  const existing = getDocMeta(docId);

  if (!existing) {
    if (req.file) fs.unlinkSync(req.file.path);
    res.status(404).json({ error: 'Document not found' });
    return;
  }

  if (!req.file) {
    const storedPath = existing.pdfStoragePath ?? getPdfPath(docId);
    if (!fs.existsSync(storedPath)) {
      res.status(400).json({ error: 'No PDF uploaded and no stored copy found.' });
      return;
    }
    invalidateChunkCache(docId);
    const job = await reindexDoc(docId, storedPath, {
      country: existing.country, grade: existing.grade,
      subject: existing.subject, track: existing.track,
      filename: existing.filename,
    });
    // Invalidate search cache — reindex produces new chunks.
    cache.invalidateSubjectSearch(existing.country, existing.grade, existing.subject).catch(() => undefined);
    res.status(202).json({ jobId: job.id, docId, status: 'queued', source: 'stored_pdf' });
    return;
  }

  const reindexFilename = fixEncoding(req.file.originalname) || existing.filename;
  req.log.info({ docId, filename: reindexFilename }, 'Reindex with new PDF');
  invalidateChunkCache(docId);
  const job = await reindexDoc(docId, req.file.path, {
    country: existing.country, grade: existing.grade,
    subject: existing.subject, track: existing.track,
    filename: reindexFilename,
  });
  // Invalidate search cache — reindex produces new chunks.
  cache.invalidateSubjectSearch(existing.country, existing.grade, existing.subject).catch(() => undefined);
  res.status(202).json({ jobId: job.id, docId, status: 'queued', source: 'new_upload' });
});

// ─── GET /api/curriculum/search ───────────────────────────────────────────────
// Mode A (subject-wide): omit bookTitle param.
// Mode B (book-specific): include bookTitle param.
// Always includes caller's private docs alongside public ones.
router.get('/search', requireAuth, async (req, res) => {
  const { country, grade, subject, query = '', topK, bookTitle } =
    req.query as Record<string, string>;

  if (!country || !grade || !subject) {
    res.status(400).json({ error: 'country, grade, and subject are required' });
    return;
  }

  // ── Cache lookup ────────────────────────────────────────────────────────────
  const uid       = req.user!.uid;
  const queryHash = cache.hashPart({ query, topK, bookTitle });
  const cacheKey  = cache.searchKey(uid, country, grade, subject, queryHash);
  const cached    = await cache.get<unknown>(cacheKey);
  if (cached !== null) {
    res.setHeader('X-Cache', 'HIT');
    res.json(cached);
    return;
  }

  // Pre-compute query embedding for hybrid (keyword + semantic) search.
  // Falls back to keyword-only gracefully if embedding API is unavailable.
  let queryEmbedding: number[] | undefined;
  if (query.trim()) {
    try {
      const { getEmbedding } = await import('../lib/embeddingService');
      queryEmbedding = await getEmbedding(query);
    } catch {
      // Non-fatal — keyword scoring still runs
    }
  }

  invalidateChunkCache();
  const chunks = searchChunks(
    country, grade, subject, query,
    topK ? parseInt(topK) : 10,
    { bookTitle: bookTitle || undefined, userId: uid, queryEmbedding }
  );

  const result = { chunks, count: chunks.length };
  cache.set(cacheKey, result, cache.TTL.SEARCH).catch(() => undefined);
  res.setHeader('X-Cache', 'MISS');
  res.json(result);
});

// ─── GET /api/curriculum/chunks/:docId ───────────────────────────────────────
router.get('/chunks/:docId', requireAuth, (req, res) => {
  const docId = str(req.params.docId);
  const doc   = getDocMeta(docId);
  if (!doc) { res.status(404).json({ error: 'Document not found' }); return; }

  const uid = req.user!.uid;
  if (doc.visibility === 'private' && doc.ownerId !== uid && !isAdmin(req.user!)) {
    res.status(403).json({ error: 'Access denied' });
    return;
  }

  invalidateChunkCache(docId);
  const chunks = loadChunks(docId);
  res.json({ chunks, count: chunks.length });
});

// ─── GET /api/curriculum/debug/:docId ────────────────────────────────────────
// Admin only — diagnostic endpoint.
router.get('/debug/:docId', requireAuth, requireAdmin, (req, res) => {
  const docId = str(req.params.docId);
  const { chunkIndex = '0', query = '' } = req.query as Record<string, string>;
  invalidateChunkCache(docId);
  const chunks = loadChunks(docId);

  if (chunks.length === 0) {
    res.status(404).json({ error: 'No chunks found' });
    return;
  }

  const idx   = Math.min(parseInt(chunkIndex), chunks.length - 1);
  const chunk = chunks[idx];

  const raw200    = chunk.content.slice(0, 200);
  const hexCodes  = Array.from(raw200).map((ch) => {
    const cp = ch.codePointAt(0)!;
    return cp > 0x007e || cp < 0x0020 ? `[U+${cp.toString(16).padStart(4, '0')}]` : ch;
  }).join('');

  const normalized = normalizeArabic(chunk.content);
  const tokens     = tokenize(chunk.content).slice(0, 20);

  const queryInfo = query ? {
    queryNorm:       normalizeArabic(query),
    queryTokens:     tokenize(query),
    substringMatch:  normalized.includes(normalizeArabic(query)),
  } : undefined;

  res.json({
    chunkIndex: idx, totalChunks: chunks.length,
    pageRange: chunk.pageRange, chapter: chunk.chapter,
    rawPreview: raw200, hexCodes,
    normalizedPreview: normalized.slice(0, 300),
    hasContentNormalized: 'contentNormalized' in chunk,
    keywords: chunk.keywords.slice(0, 15),
    tokens, queryInfo,
  });
});

// ─── GET /api/curriculum/verify/:id ──────────────────────────────────────────
router.get('/verify/:id', requireAuth, (req, res) => {
  const doc = getDocMeta(str(req.params.id));
  if (!doc) { res.status(404).json({ error: 'Document not found' }); return; }

  const uid = req.user!.uid;
  if (doc.visibility === 'private' && doc.ownerId !== uid && !isAdmin(req.user!)) {
    res.status(403).json({ error: 'Access denied' });
    return;
  }

  invalidateChunkCache(doc.id);
  const chunks = loadChunks(doc.id);

  if (doc.status !== 'done' && doc.status !== 'partial') {
    res.json({ searchable: false, reason: `Status is '${doc.status}'`, chunkCount: 0, doc });
    return;
  }
  if (chunks.length === 0) {
    res.json({ searchable: false, reason: 'No chunks on disk', chunkCount: 0, doc });
    return;
  }

  const results   = searchChunks(doc.country, doc.grade, doc.subject, '', 1, { userId: uid });
  const searchable = results.length > 0;

  res.json({
    searchable,
    reason: searchable
      ? doc.status === 'partial'
        ? `Partial doc is searchable (pages 1–${doc.lastRenderedPage ?? '?'} of ${doc.totalPages})`
        : 'Document is live in search index'
      : 'Search returned 0 results despite chunks existing',
    chunkCount: chunks.length,
    resumable: doc.status === 'partial',
    doc,
  });
});

export default router;
