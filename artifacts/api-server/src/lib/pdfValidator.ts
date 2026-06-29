/**
 * pdfValidator — PDF Security Layer.
 *
 * Validates PDF files BEFORE sending to OCR/Gemini to:
 * - Prevent malicious uploads
 * - Catch corrupt/blank/empty PDFs early
 * - Detect duplicates via SHA-256 hash
 * - Save Gemini quota on invalid files
 *
 * Usage:
 *   const result = await validatePdf(filePath, { ownerId, docId });
 *   if (!result.valid) { return res.status(400).json({ error: result.reason }); }
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { getMigrationPool } from './dbMigrations';
import { logger } from './logger';

// ─── Constants ────────────────────────────────────────────────────────────────

const PDF_MAGIC           = '%PDF-';
const MIN_VALID_SIZE_BYTES = 1024;          // < 1KB is definitely invalid
const MAX_SIZE_BYTES       = 150 * 1024 * 1024; // 150MB (same as multer limit)
const BLANK_PAGE_THRESHOLD = 0.02;          // < 2% printable chars → blank scan

/** Known malicious/invalid byte sequences found in PDF exploits. */
const SUSPICIOUS_PATTERNS = [
  /\/JS\s*<<.*?>>/is,     // JavaScript in PDF
  /\/JavaScript\s*<<.*?>>/is,
  /\/Launch\s*<<.*?>>/is, // Launch action (RCE vector)
  /\/EmbeddedFile\s*<<.*?>>/is,
];

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PdfValidationOptions {
  ownerId?:      string | null;
  docId?:        string;
  skipDupeCheck?: boolean;
}

export interface PdfValidationResult {
  valid:   boolean;
  reason?: string;
  sha256?: string;
  sizeKB?: number;
  /** docId that previously uploaded the same file, if duplicate detected. */
  duplicateDocId?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function computeSha256(filePath: string): string {
  const hash = crypto.createHash('sha256');
  const data = fs.readFileSync(filePath);
  hash.update(data);
  return hash.digest('hex');
}

/** Read the first N bytes of a file. */
function readHeader(filePath: string, bytes = 1024): Buffer {
  const fd  = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(bytes);
  const n   = fs.readSync(fd, buf, 0, bytes, 0);
  fs.closeSync(fd);
  return buf.slice(0, n);
}

/** Estimate content density of extracted text. */
function estimateDensity(header: Buffer): number {
  const text = header.toString('binary');
  const printable = (text.match(/[\x20-\x7E]/g) || []).length;
  return printable / Math.max(text.length, 1);
}

// ─── Core validator ───────────────────────────────────────────────────────────

export async function validatePdf(
  filePath:    string,
  options:     PdfValidationOptions = {}
): Promise<PdfValidationResult> {

  // ── 1. File exists ──────────────────────────────────────────────────────────
  if (!fs.existsSync(filePath)) {
    return { valid: false, reason: 'File not found on server' };
  }

  // ── 2. Extension check ──────────────────────────────────────────────────────
  if (!filePath.toLowerCase().endsWith('.pdf')) {
    return { valid: false, reason: 'File must have a .pdf extension' };
  }

  // ── 3. Size check ───────────────────────────────────────────────────────────
  const stat   = fs.statSync(filePath);
  const sizeKB = Math.round(stat.size / 1024);

  if (stat.size < MIN_VALID_SIZE_BYTES) {
    return { valid: false, reason: `File is too small (${sizeKB} KB) — likely blank or corrupt`, sizeKB };
  }

  if (stat.size > MAX_SIZE_BYTES) {
    return {
      valid: false,
      reason: `File exceeds 150 MB limit (${Math.round(sizeKB / 1024)} MB)`,
      sizeKB,
    };
  }

  // ── 4. MIME / magic bytes check ─────────────────────────────────────────────
  const header = readHeader(filePath, 1024);
  const headerStr = header.toString('binary');

  if (!headerStr.startsWith(PDF_MAGIC)) {
    return { valid: false, reason: 'File is not a valid PDF (invalid magic bytes)' };
  }

  // ── 5. Corruption detection — check for %%EOF ────────────────────────────
  // Read last 1KB to find the EOF marker
  const tailBuf = Buffer.alloc(1024);
  const fd      = fs.openSync(filePath, 'r');
  const tailOff = Math.max(0, stat.size - 1024);
  fs.readSync(fd, tailBuf, 0, 1024, tailOff);
  fs.closeSync(fd);
  const tailStr = tailBuf.toString('binary');

  if (!tailStr.includes('%%EOF')) {
    return { valid: false, reason: 'PDF appears to be truncated or corrupt (missing %%EOF)' };
  }

  // ── 6. Blank PDF detection ──────────────────────────────────────────────────
  // A file that is under 5KB after header is almost certainly blank
  if (stat.size < 5120 && sizeKB < 5) {
    return { valid: false, reason: 'PDF appears to be blank or contains no content', sizeKB };
  }

  // ── 7. Malicious pattern detection ─────────────────────────────────────────
  // Read more of the file for JS detection (first 32KB is enough for header attacks)
  const scanBuf = Buffer.alloc(32768);
  const scanFd  = fs.openSync(filePath, 'r');
  const scanN   = fs.readSync(scanFd, scanBuf, 0, 32768, 0);
  fs.closeSync(scanFd);
  const scanStr = scanBuf.slice(0, scanN).toString('latin1');

  for (const pattern of SUSPICIOUS_PATTERNS) {
    if (pattern.test(scanStr)) {
      logger.warn({ filePath, pattern: pattern.source }, 'pdfValidator: suspicious pattern detected');
      return { valid: false, reason: 'PDF contains potentially unsafe content and was rejected' };
    }
  }

  // ── 8. SHA-256 hash + duplicate detection ────────────────────────────────────
  const sha256 = computeSha256(filePath);

  if (!options.skipDupeCheck) {
    try {
      const db  = getMigrationPool();
      const row = await db.query<{ doc_id: string; owner_id: string | null }>(
        `SELECT doc_id, owner_id FROM public.pdf_upload_hashes WHERE sha256 = $1 LIMIT 1`,
        [sha256]
      );

      if (row.rows.length > 0) {
        const existing = row.rows[0]!;
        // Same owner → definite duplicate
        // Different owner → allow (different user's copy)
        const sameOwner =
          options.ownerId && existing.owner_id && existing.owner_id === options.ownerId;

        if (sameOwner) {
          return {
            valid:          false,
            reason:         'This PDF has already been uploaded',
            sha256,
            sizeKB,
            duplicateDocId: existing.doc_id,
          };
        }
      }
    } catch (err) {
      // Non-fatal — continue if dupe check DB is unavailable
      logger.warn({ err }, 'pdfValidator: dupe check skipped — DB error');
    }
  }

  return { valid: true, sha256, sizeKB };
}

// ─── Record hash after successful upload ─────────────────────────────────────

export async function recordPdfHash(
  sha256:  string,
  docId:   string,
  ownerId: string | null
): Promise<void> {
  try {
    const db = getMigrationPool();
    await db.query(
      `INSERT INTO public.pdf_upload_hashes (sha256, doc_id, owner_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (sha256) DO NOTHING`,
      [sha256, docId, ownerId]
    );
  } catch (err) {
    logger.warn({ err, docId }, 'pdfValidator: failed to record hash — non-fatal');
  }
}

// ─── Remove hash on doc deletion ─────────────────────────────────────────────

export async function removePdfHash(docId: string): Promise<void> {
  try {
    const db = getMigrationPool();
    await db.query('DELETE FROM public.pdf_upload_hashes WHERE doc_id = $1', [docId]);
  } catch (err) {
    logger.warn({ err, docId }, 'pdfValidator: failed to remove hash — non-fatal');
  }
}
