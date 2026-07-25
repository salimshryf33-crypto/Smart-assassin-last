/**
 * storageService.ts
 *
 * Production-grade object storage for Sage curriculum PDFs.
 * Uses Replit's built-in Object Storage (GCS-backed, private bucket).
 *
 * Design principles:
 *  - All PDFs stored at key:  pdfs/{docId}.pdf
 *  - Private bucket — no direct public access ever
 *  - Signed URLs for time-limited, secure per-request access
 *  - Upload verified by size + MD5 checksum before returning ok
 *  - Local disk file is NEVER deleted by this service (caller decides)
 *  - All methods return StorageResult<T> — never throw to callers
 *  - Graceful degradation: if storage is unavailable, ok:false is returned
 *    and the caller falls back to disk / DB as before
 *
 * Backward compatibility:
 *  - If local disk file exists → OCR / extraction continue unchanged
 *  - Object storage is the durable layer that survives container resets
 *    and scales to 100s of books without bloating PostgreSQL
 */

import { Storage }  from '@google-cloud/storage';
import fs           from 'node:fs';
import path         from 'node:path';
import crypto       from 'node:crypto';
import { logger }   from '../lib/logger';

// ─── Configuration ─────────────────────────────────────────────────────────────

const SIDECAR   = 'http://127.0.0.1:1106';
const BUCKET_ID = process.env['DEFAULT_OBJECT_STORAGE_BUCKET_ID'];

const objectKey = (docId: string) => `pdfs/${docId}.pdf`;

// ─── GCS client — Replit sidecar auth, never cached (tokens expire) ───────────

function makeClient(): Storage {
  return new Storage({
    credentials: {
      audience:            'replit',
      subject_token_type:  'access_token',
      token_url:           `${SIDECAR}/token`,
      type:                'external_account',
      credential_source: {
        url:    `${SIDECAR}/credential`,
        format: { type: 'json', subject_token_field_name: 'access_token' },
      },
      universe_domain: 'googleapis.com',
    },
    projectId: '',
  } as ConstructorParameters<typeof Storage>[0]);
}

// ─── Result type ───────────────────────────────────────────────────────────────

export type StorageResult<T = void> =
  | { ok: true;  value: T }
  | { ok: false; error: string };

// ─── Guard ─────────────────────────────────────────────────────────────────────

function bucketReady(): boolean {
  return !!BUCKET_ID;
}

// ─── MD5 helper ────────────────────────────────────────────────────────────────

function md5Base64(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('md5').update(buf).digest('base64');
}

// ───────────────────────────────────────────────────────────────────────────────
//  uploadPdf
//  Upload a PDF from local disk to object storage.
//  Verifies size and MD5 checksum after upload before returning ok:true.
//  Never deletes the local file.
// ───────────────────────────────────────────────────────────────────────────────

export async function uploadPdf(
  docId:     string,
  localPath: string,
): Promise<StorageResult> {
  if (!bucketReady()) {
    return { ok: false, error: 'Object storage not configured (DEFAULT_OBJECT_STORAGE_BUCKET_ID missing)' };
  }
  if (!fs.existsSync(localPath)) {
    return { ok: false, error: `Local file not found: ${localPath}` };
  }

  try {
    const localStat  = fs.statSync(localPath);
    const localMd5   = md5Base64(localPath);
    const key        = objectKey(docId);
    const client     = makeClient();
    const bucket     = client.bucket(BUCKET_ID!);
    const fileHandle = bucket.file(key);

    await bucket.upload(localPath, {
      destination: key,
      metadata: {
        contentType: 'application/pdf',
        metadata: {
          docId,
          uploadedAt: new Date().toISOString(),
        },
      },
    });

    // ── Integrity verification ────────────────────────────────────────────────
    const [meta]        = await fileHandle.getMetadata();
    const remoteSize    = Number(meta.size ?? 0);
    const remoteMd5     = (meta.md5Hash as string | undefined) ?? '';

    if (remoteSize !== localStat.size) {
      await fileHandle.delete().catch(() => {});
      return {
        ok: false,
        error: `Size mismatch after upload — local=${localStat.size} remote=${remoteSize}`,
      };
    }

    if (remoteMd5 && remoteMd5 !== localMd5) {
      await fileHandle.delete().catch(() => {});
      return {
        ok: false,
        error: `Checksum mismatch after upload — local=${localMd5} remote=${remoteMd5}`,
      };
    }

    logger.info({ docId, key, bytes: localStat.size }, 'storageService: PDF uploaded and verified');
    return { ok: true, value: undefined };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ docId, err: msg }, 'storageService: upload failed — local disk remains authoritative');
    return { ok: false, error: msg };
  }
}

// ───────────────────────────────────────────────────────────────────────────────
//  downloadPdf
//  Download a PDF from object storage to a local destination path.
//  Creates parent directories automatically.
// ───────────────────────────────────────────────────────────────────────────────

export async function downloadPdf(
  docId:    string,
  destPath: string,
): Promise<StorageResult> {
  if (!bucketReady()) {
    return { ok: false, error: 'Object storage not configured' };
  }

  try {
    const key    = objectKey(docId);
    const client = makeClient();
    const file   = client.bucket(BUCKET_ID!).file(key);

    const [exists] = await file.exists();
    if (!exists) {
      return { ok: false, error: `Object not found in storage: ${key}` };
    }

    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    await file.download({ destination: destPath });

    logger.info({ docId, destPath }, 'storageService: PDF downloaded from object storage');
    return { ok: true, value: undefined };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ docId, err: msg }, 'storageService: download failed');
    return { ok: false, error: msg };
  }
}

// ───────────────────────────────────────────────────────────────────────────────
//  pdfExistsInStorage
//  Returns true if the object exists in the bucket.
// ───────────────────────────────────────────────────────────────────────────────

export async function pdfExistsInStorage(docId: string): Promise<boolean> {
  if (!bucketReady()) return false;
  try {
    const [exists] = await makeClient()
      .bucket(BUCKET_ID!)
      .file(objectKey(docId))
      .exists();
    return exists;
  } catch {
    return false;
  }
}

// ───────────────────────────────────────────────────────────────────────────────
//  deletePdf
//  Remove a PDF from object storage.
//  Safe to call even if the object does not exist.
// ───────────────────────────────────────────────────────────────────────────────

export async function deletePdf(docId: string): Promise<StorageResult> {
  if (!bucketReady()) {
    return { ok: false, error: 'Object storage not configured' };
  }
  try {
    await makeClient()
      .bucket(BUCKET_ID!)
      .file(objectKey(docId))
      .delete({ ignoreNotFound: true });

    logger.info({ docId }, 'storageService: PDF deleted from object storage');
    return { ok: true, value: undefined };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ docId, err: msg }, 'storageService: delete failed');
    return { ok: false, error: msg };
  }
}

// ───────────────────────────────────────────────────────────────────────────────
//  getSignedUrl
//  Generate a time-limited signed GET URL (default: 15 minutes).
//  Used to serve PDFs securely without permanent public access.
// ───────────────────────────────────────────────────────────────────────────────

export async function getSignedUrl(
  docId:      string,
  ttlSeconds: number = 900,
): Promise<StorageResult<string>> {
  if (!bucketReady()) {
    return { ok: false, error: 'Object storage not configured' };
  }
  try {
    const expires = new Date(Date.now() + ttlSeconds * 1_000).toISOString();

    const resp = await fetch(`${SIDECAR}/object-storage/signed-object-url`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bucket_name: BUCKET_ID,
        object_name: objectKey(docId),
        method:      'GET',
        expires_at:  expires,
      }),
    });

    if (!resp.ok) {
      return { ok: false, error: `Sidecar signed-url returned HTTP ${resp.status}` };
    }

    const { signed_url } = (await resp.json()) as { signed_url: string };
    logger.info({ docId, ttlSeconds }, 'storageService: signed URL generated');
    return { ok: true, value: signed_url };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ docId, err: msg }, 'storageService: getSignedUrl failed');
    return { ok: false, error: msg };
  }
}

// ───────────────────────────────────────────────────────────────────────────────
//  isStorageHealthy
//  Lightweight health check — verifies bucket is reachable.
// ───────────────────────────────────────────────────────────────────────────────

export async function isStorageHealthy(): Promise<boolean> {
  if (!bucketReady()) return false;
  try {
    // Use signed-URL probe instead of bucket.getMetadata() —
    // the sidecar only grants object-level IAM, not bucket-admin.
    const resp = await fetch(`${SIDECAR}/object-storage/signed-object-url`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bucket_name: BUCKET_ID,
        object_name: 'pdfs/__health_probe__.pdf',
        method:      'GET',
        expires_at:  new Date(Date.now() + 60_000).toISOString(),
      }),
    });
    return resp.status < 500;
  } catch {
    return false;
  }
}
