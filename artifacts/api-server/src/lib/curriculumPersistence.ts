/**
 * curriculumPersistence.ts
 *
 * PostgreSQL ↔ disk bridge for curriculum metadata.
 * PostgreSQL = source of truth.  Disk = cache only.
 *
 * Public API (fire-and-forget variants used by curriculumStorage):
 *   upsertDocMetaToDB(doc)
 *   deleteDocFromDB(docId)
 *   saveChunksToDB(docId, chunks)
 *
 * Startup restoration:
 *   restoreCurriculumFromDB()   ← call once before migrateIndex()
 */

import fs   from 'node:fs';
import path from 'node:path';
import { logger } from './logger';
import { getSharedPool } from './dbPool';
import type { CurriculumDocument, CurriculumChunk } from './curriculumStorage';

// ─── DB pool (shared singleton) ───────────────────────────────────────────────

function getPool() {
  return getSharedPool();
}

// ─── Disk paths (kept in sync with curriculumStorage) ────────────────────────

const DATA_DIR  = path.join(process.cwd(), 'data', 'curriculum');
const DOCS_DIR  = path.join(DATA_DIR, 'docs');
const INDEX_FILE = path.join(DATA_DIR, 'index.json');

function ensureDirs() {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
}

// ─── Doc → DB ─────────────────────────────────────────────────────────────────

export async function upsertDocMetaToDB(doc: CurriculumDocument): Promise<void> {
  const db = getPool();
  await db.query(
    `INSERT INTO public.curriculum_documents (
       id, country, grade, subject, track, filename,
       total_pages, chunk_count, status, error_message,
       uploaded_at, processed_at, doc_type, owner_id,
       visibility, book_title, extraction_method, extracted_chars,
       avg_chars_per_page, extracted_pages, last_rendered_page,
       pdf_storage_path, last_resume_attempt, resume_attempts,
       last_resume_error, updated_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
       $11,$12,$13,$14,$15,$16,$17,$18,
       $19,$20,$21,$22,$23,$24,$25,now()
     )
     ON CONFLICT (id) DO UPDATE SET
       country            = EXCLUDED.country,
       grade              = EXCLUDED.grade,
       subject            = EXCLUDED.subject,
       track              = EXCLUDED.track,
       filename           = EXCLUDED.filename,
       total_pages        = EXCLUDED.total_pages,
       chunk_count        = EXCLUDED.chunk_count,
       status             = EXCLUDED.status,
       error_message      = EXCLUDED.error_message,
       uploaded_at        = EXCLUDED.uploaded_at,
       processed_at       = EXCLUDED.processed_at,
       doc_type           = EXCLUDED.doc_type,
       owner_id           = EXCLUDED.owner_id,
       visibility         = EXCLUDED.visibility,
       book_title         = EXCLUDED.book_title,
       extraction_method  = EXCLUDED.extraction_method,
       extracted_chars    = EXCLUDED.extracted_chars,
       avg_chars_per_page = EXCLUDED.avg_chars_per_page,
       extracted_pages    = EXCLUDED.extracted_pages,
       last_rendered_page = EXCLUDED.last_rendered_page,
       pdf_storage_path   = EXCLUDED.pdf_storage_path,
       last_resume_attempt= EXCLUDED.last_resume_attempt,
       resume_attempts    = EXCLUDED.resume_attempts,
       last_resume_error  = EXCLUDED.last_resume_error,
       updated_at         = now()`,
    [
      doc.id, doc.country, doc.grade, doc.subject, doc.track ?? '', doc.filename,
      doc.totalPages, doc.chunkCount, doc.status, doc.errorMessage ?? null,
      doc.uploadedAt, doc.processedAt ?? null, doc.docType ?? null, doc.ownerId ?? null,
      doc.visibility ?? 'public', doc.bookTitle ?? null, doc.extractionMethod ?? null,
      doc.extractedChars ?? null, doc.avgCharsPerPage ?? null, doc.extractedPages ?? null,
      doc.lastRenderedPage ?? null, doc.pdfStoragePath ?? null,
      doc.lastResumeAttempt ?? null, doc.resumeAttempts ?? null, doc.lastResumeError ?? null,
    ]
  );
}

// ─── Chunks → DB ─────────────────────────────────────────────────────────────
// Full replace: delete existing rows for docId, then bulk-insert.

export async function saveChunksToDB(docId: string, chunks: CurriculumChunk[]): Promise<void> {
  if (chunks.length === 0) return;
  const db = getPool();

  await db.query('DELETE FROM public.curriculum_chunks WHERE doc_id = $1', [docId]);

  // Bulk insert in batches of 50 to stay within parameter limits
  const BATCH = 50;
  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH);
    const values: unknown[] = [];
    const placeholders = batch.map((c, j) => {
      const base = j * 12;
      values.push(
        c.id, c.docId, c.country, c.grade, c.subject,
        c.chapter, c.pageRange, c.chunkIndex,
        c.content, c.contentNormalized ?? '',
        JSON.stringify(c.keywords ?? []),
        c.embedding ? JSON.stringify(c.embedding) : null
      );
      return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8},$${base+9},$${base+10},$${base+11},$${base+12})`;
    });

    await db.query(
      `INSERT INTO public.curriculum_chunks
         (id,doc_id,country,grade,subject,chapter,page_range,chunk_index,
          content,content_normalized,keywords,embedding)
       VALUES ${placeholders.join(',')}
       ON CONFLICT (id) DO UPDATE SET
         chapter            = EXCLUDED.chapter,
         content            = EXCLUDED.content,
         content_normalized = EXCLUDED.content_normalized,
         keywords           = EXCLUDED.keywords,
         embedding          = EXCLUDED.embedding,
         updated_at         = now()`,
      values
    );
  }
}

// ─── Delete → DB ─────────────────────────────────────────────────────────────

export async function deleteDocFromDB(docId: string): Promise<void> {
  const db = getPool();
  await db.query('DELETE FROM public.curriculum_chunks  WHERE doc_id = $1', [docId]);
  await db.query('DELETE FROM public.curriculum_documents WHERE id = $1',    [docId]);
}

// ─── Startup: restore disk from DB ───────────────────────────────────────────
//
// Called once at startup, BEFORE migrateIndex() and relabelChapters().
// For each doc in DB:
//   • If index.json is missing/stale → rebuild it from DB rows
//   • If docs/{docId}.json is missing → rebuild it from DB chunks
//
// This is a no-op when disk is already up-to-date (normal case).

export async function restoreCurriculumFromDB(): Promise<void> {
  ensureDirs();
  const db = getPool();

  // 1. Fetch all docs from DB
  const { rows: dbDocs } = await db.query<Record<string, unknown>>(
    'SELECT * FROM public.curriculum_documents ORDER BY uploaded_at ASC'
  );

  if (dbDocs.length === 0) {
    // DB is empty — seed it from disk if disk has data
    await seedDBFromDisk();
    return;
  }

  // 2. Map DB rows → CurriculumDocument shape
  const docs: CurriculumDocument[] = dbDocs.map(rowToDoc);

  // 3. Rebuild index.json if missing or has fewer docs
  const diskDocs = readDiskIndex();
  const diskIds  = new Set(diskDocs.map((d) => d.id));
  const missingFromDisk = docs.filter((d) => !diskIds.has(d.id));

  if (missingFromDisk.length > 0 || !fs.existsSync(INDEX_FILE)) {
    // Merge: keep everything from DB, supplement with any disk-only extras
    const dbIds    = new Set(docs.map((d) => d.id));
    const diskOnly = diskDocs.filter((d) => !dbIds.has(d.id));
    const merged   = [...docs, ...diskOnly];
    writeDiskIndex(merged);
    logger.info(
      { restored: missingFromDisk.length, total: merged.length },
      'restoreCurriculumFromDB: rebuilt index.json from DB'
    );
  }

  // 4. Rebuild missing chunk files
  let restoredChunks = 0;
  for (const doc of docs) {
    const chunkFile = path.join(DOCS_DIR, `${doc.id}.json`);
    if (fs.existsSync(chunkFile)) continue;

    const { rows: chunkRows } = await db.query<Record<string, unknown>>(
      'SELECT * FROM curriculum_chunks WHERE doc_id = $1 ORDER BY chunk_index ASC',
      [doc.id]
    );
    if (chunkRows.length === 0) continue;

    const chunks: CurriculumChunk[] = chunkRows.map(rowToChunk);
    fs.writeFileSync(chunkFile, JSON.stringify(chunks));
    restoredChunks++;
    logger.info(
      { docId: doc.id, chunks: chunks.length },
      'restoreCurriculumFromDB: restored chunk file'
    );
  }

  if (restoredChunks > 0) {
    logger.info({ restoredChunks }, 'restoreCurriculumFromDB: chunk files restored');
  } else {
    logger.info('restoreCurriculumFromDB: disk already up-to-date');
  }
}

// ─── Seed DB from disk (first run) ───────────────────────────────────────────
// Called when DB is empty but disk has data. Migrates disk → DB once.

async function seedDBFromDisk(): Promise<void> {
  const diskDocs = readDiskIndex();
  if (diskDocs.length === 0) {
    logger.info('restoreCurriculumFromDB: no data on disk or DB — nothing to do');
    return;
  }

  logger.info(
    { count: diskDocs.length },
    'restoreCurriculumFromDB: DB empty — seeding from disk'
  );

  for (const doc of diskDocs) {
    try {
      await upsertDocMetaToDB(doc);
    } catch (err) {
      logger.error({ err, docId: doc.id }, 'restoreCurriculumFromDB: failed to seed doc');
      continue;
    }

    // Seed chunks
    const chunkFile = path.join(DOCS_DIR, `${doc.id}.json`);
    if (!fs.existsSync(chunkFile)) continue;

    try {
      const raw    = JSON.parse(fs.readFileSync(chunkFile, 'utf8'));
      const chunks: CurriculumChunk[] = Array.isArray(raw)
        ? raw
        : Array.isArray((raw as Record<string, unknown>).chunks)
          ? (raw as Record<string, unknown[]>).chunks as CurriculumChunk[]
          : [];
      if (chunks.length > 0) {
        await saveChunksToDB(doc.id, chunks);
        logger.info({ docId: doc.id, chunks: chunks.length }, 'restoreCurriculumFromDB: seeded chunks');
      }
    } catch (err) {
      logger.error({ err, docId: doc.id }, 'restoreCurriculumFromDB: failed to seed chunks');
    }
  }

  logger.info({ seeded: diskDocs.length }, 'restoreCurriculumFromDB: initial DB seed complete');
}

// ─── Row mappers ─────────────────────────────────────────────────────────────

function rowToDoc(r: Record<string, unknown>): CurriculumDocument {
  return {
    id:                 r['id']                  as string,
    country:            r['country']             as string,
    grade:              r['grade']               as string,
    subject:            r['subject']             as string,
    track:              r['track']               as string ?? '',
    filename:           r['filename']            as string,
    totalPages:         Number(r['total_pages']  ?? 0),
    chunkCount:         Number(r['chunk_count']  ?? 0),
    status:             r['status']              as CurriculumDocument['status'],
    errorMessage:       r['error_message']       as string | undefined,
    uploadedAt:         Number(r['uploaded_at']  ?? 0),
    processedAt:        r['processed_at']   != null ? Number(r['processed_at'])  : undefined,
    docType:            r['doc_type']            as CurriculumDocument['docType'],
    ownerId:            r['owner_id']            as string | null | undefined,
    visibility:         (r['visibility'] ?? 'public') as 'public' | 'private',
    bookTitle:          r['book_title']          as string | undefined,
    extractionMethod:   r['extraction_method']   as CurriculumDocument['extractionMethod'],
    extractedChars:     r['extracted_chars']  != null ? Number(r['extracted_chars'])    : undefined,
    avgCharsPerPage:    r['avg_chars_per_page'] != null ? Number(r['avg_chars_per_page']): undefined,
    extractedPages:     r['extracted_pages']  != null ? Number(r['extracted_pages'])    : undefined,
    lastRenderedPage:   r['last_rendered_page'] != null ? Number(r['last_rendered_page']): undefined,
    pdfStoragePath:     r['pdf_storage_path']    as string | undefined,
    lastResumeAttempt:  r['last_resume_attempt'] != null ? Number(r['last_resume_attempt']): undefined,
    resumeAttempts:     r['resume_attempts']  != null ? Number(r['resume_attempts'])    : undefined,
    lastResumeError:    r['last_resume_error']   as string | undefined,
  };
}

function rowToChunk(r: Record<string, unknown>): CurriculumChunk {
  const kw  = r['keywords'];
  const emb = r['embedding'];
  return {
    id:                r['id']               as string,
    docId:             r['doc_id']           as string,
    country:           r['country']          as string,
    grade:             r['grade']            as string,
    subject:           r['subject']          as string,
    chapter:           r['chapter']          as string,
    pageRange:         r['page_range']       as string,
    chunkIndex:        Number(r['chunk_index'] ?? 0),
    content:           r['content']          as string,
    contentNormalized: r['content_normalized'] as string,
    keywords:          Array.isArray(kw) ? kw as string[] : (typeof kw === 'string' ? JSON.parse(kw) : []),
    embedding:         emb != null
      ? (Array.isArray(emb) ? emb as number[] : JSON.parse(emb as string) as number[])
      : undefined,
  };
}

// ─── Disk helpers (private — avoid circular import) ──────────────────────────

function readDiskIndex(): CurriculumDocument[] {
  if (!fs.existsSync(INDEX_FILE)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    return Array.isArray(raw) ? raw as CurriculumDocument[] : [];
  } catch {
    return [];
  }
}

function writeDiskIndex(docs: CurriculumDocument[]) {
  ensureDirs();
  fs.writeFileSync(INDEX_FILE, JSON.stringify(docs, null, 2));
}
