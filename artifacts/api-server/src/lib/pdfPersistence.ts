/**
 * PostgreSQL-backed PDF persistence.
 *
 * Why: Local disk at data/pdfs/ is ephemeral — files are lost on container
 * restarts, checkpoint restores, and Replit deployments. Storing the raw PDF
 * bytes in the database gives us persistence that survives all of those events.
 *
 * The disk copy is kept for fast access during active OCR sessions. The DB copy
 * is the authoritative, durable source that can restore the disk copy on demand.
 *
 * Impact on other subsystems: none. Chunks, search, chat retrieval, and
 * curriculum metadata are stored entirely in JSON files and are never affected
 * by this module.
 */

import fs from 'node:fs';
import path from 'node:path';
import { logger } from './logger';
import { getSharedPool } from './dbPool';

const pool = getSharedPool();

/**
 * Save a PDF file from disk into the database.
 * Uses UPSERT so re-uploading the same docId is safe.
 */
export async function savePdfToDb(docId: string, filePath: string): Promise<void> {
  const content = fs.readFileSync(filePath);
  await pool.query(
    `INSERT INTO public.curriculum_pdfs (doc_id, content, byte_size, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (doc_id) DO UPDATE
       SET content    = EXCLUDED.content,
           byte_size  = EXCLUDED.byte_size,
           updated_at = NOW()`,
    [docId, content, content.length]
  );
  logger.info({ docId, bytes: content.length }, 'PdfPersistence: saved to database');
}

/**
 * Restore a PDF from the database to destPath on disk.
 * Returns true if found and written, false if no record exists.
 */
export async function restorePdfFromDb(docId: string, destPath: string): Promise<boolean> {
  const res = await pool.query<{ content: Buffer }>(
    'SELECT content FROM public.curriculum_pdfs WHERE doc_id = $1',
    [docId]
  );
  if (res.rows.length === 0) return false;
  const buf = res.rows[0].content;
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, buf);
  logger.info({ docId, bytes: buf.length, destPath }, 'PdfPersistence: restored from database to disk');
  return true;
}

/**
 * Returns true if a PDF record exists in the database for this docId.
 */
export async function pdfExistsInDb(docId: string): Promise<boolean> {
  const res = await pool.query(
    'SELECT 1 FROM public.curriculum_pdfs WHERE doc_id = $1',
    [docId]
  );
  return res.rows.length > 0;
}

/**
 * Delete a PDF record from the database. Called when a curriculum doc is deleted.
 */
export async function deletePdfFromDb(docId: string): Promise<void> {
  await pool.query('DELETE FROM public.curriculum_pdfs WHERE doc_id = $1', [docId]);
  logger.info({ docId }, 'PdfPersistence: deleted from database');
}
