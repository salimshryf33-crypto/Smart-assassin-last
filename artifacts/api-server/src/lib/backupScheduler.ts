/**
 * backupScheduler — Daily PostgreSQL backup with compression and verification.
 *
 * Schedule: 02:00 UTC every day.
 * Storage:  data/backups/ (30-day retention on disk).
 * Audit:    db_backup_log table (metadata only — no circular bytea storage).
 *
 * pg_dump is used with full DATABASE_URL so SSL is respected automatically.
 * PGPASSWORD / PGSSLMODE overrides are set in the child process env for safety.
 *
 * Requirements:
 *   - pg_dump must be available in PATH  (postgresql package in nixpkgs)
 *   - DATABASE_URL env var must be set
 */
import { execFile }  from 'node:child_process';
import { promisify } from 'node:util';
import fs            from 'node:fs';
import path          from 'node:path';
import zlib          from 'node:zlib';
import { pipeline }  from 'node:stream/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { getSharedPool }    from './dbPool';
import { logger }    from './logger';

const execFileAsync = promisify(execFile);

const BACKUP_DIR      = path.join(process.cwd(), 'data', 'backups');
const RETENTION_DAYS  = 30;
const BACKUP_HOUR_UTC = 2;   // 02:00 UTC

fs.mkdirSync(BACKUP_DIR, { recursive: true });

// ─── Exported for testing ─────────────────────────────────────────────────────

export function msUntilNextRun(): number {
  const now  = new Date();
  const next = new Date();
  next.setUTCHours(BACKUP_HOUR_UTC, 0, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

// ─── Core backup logic ────────────────────────────────────────────────────────

export async function runBackup(): Promise<void> {
  const db  = getSharedPool();
  const now = new Date();
  const ts  = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const fileName = `sage-backup-${ts}.sql.gz`;
  const filePath = path.join(BACKUP_DIR, fileName);

  let logId: number | null = null;

  try {
    const logRes = await db.query<{ id: number }>(
      `INSERT INTO public.db_backup_log (started_at, status, file_path)
       VALUES (now(), 'running', $1) RETURNING id`,
      [filePath]
    );
    logId = logRes.rows[0]?.id ?? null;

    const dbUrl = process.env['NEON_DATABASE_URL'] ?? process.env['DATABASE_URL'];
    if (!dbUrl) throw new Error('NEON_DATABASE_URL or DATABASE_URL not set');

    logger.info({ filePath }, 'backupScheduler: starting pg_dump');

    // pg_dump respects sslmode from the connection URL.
    // We set PGSSLMODE=require in child env as a belt-and-suspenders measure
    // so pg_dump never falls back to plaintext on Neon.
    const childEnv = {
      ...process.env,
      PGSSLMODE: 'require',
      // Suppress the pg warning about SSL mode aliases (cosmetic only)
      PGSSLROOTCERT: process.env['PGSSLROOTCERT'] ?? '',
    };

    // pg_dump → gzip → file
    await execFileAsync(
      'sh',
      ['-c', `pg_dump "${dbUrl}" | gzip > "${filePath}"`],
      { env: childEnv }
    );

    // Verify integrity: gzip -t reads and discards; exits non-zero on corruption
    await execFileAsync('sh', ['-c', `gzip -t "${filePath}"`]);

    const sizeBytes = fs.statSync(filePath).size;
    const sizeKB    = Math.round(sizeBytes / 1024);

    if (logId !== null) {
      await db.query(
        `UPDATE public.db_backup_log
         SET status = 'success', finished_at = now(),
             file_size_kb = $2, verified = true
         WHERE id = $1`,
        [logId, sizeKB]
      );
    }

    logger.info(
      { filePath, sizeKB, verified: true },
      'backupScheduler: backup completed successfully'
    );

    await pruneOldBackups();

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg, filePath }, 'backupScheduler: backup failed');

    if (logId !== null) {
      await db.query(
        `UPDATE public.db_backup_log
         SET status = 'failed', finished_at = now(), error_message = $2
         WHERE id = $1`,
        [logId, msg]
      );
    }

    // Remove partial file if present
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch { /* ignore */ }

    throw err; // re-throw so callers (tests) can detect failure
  }
}

// ─── Prune old backups (disk + audit log) ─────────────────────────────────────

export async function pruneOldBackups(): Promise<void> {
  const cutoff  = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let   pruned  = 0;

  try {
    const entries = fs.readdirSync(BACKUP_DIR);
    for (const entry of entries) {
      if (!entry.startsWith('sage-backup-') || !entry.endsWith('.sql.gz')) continue;
      const fp   = path.join(BACKUP_DIR, entry);
      const stat = fs.statSync(fp);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(fp);
        pruned++;
        logger.info({ file: entry }, 'backupScheduler: pruned old backup');
      }
    }
  } catch (err) {
    logger.warn({ err: String(err) }, 'backupScheduler: pruneOldBackups disk error');
  }

  if (pruned > 0) {
    try {
      const db = getSharedPool();
      await db.query(
        `DELETE FROM public.db_backup_log
         WHERE started_at < now() - interval '${RETENTION_DAYS} days'`
      );
      logger.info({ pruned }, 'backupScheduler: pruning complete');
    } catch (err) {
      logger.warn({ err: String(err) }, 'backupScheduler: pruneOldBackups DB error');
    }
  }
}

// ─── Health check ─────────────────────────────────────────────────────────────

export interface BackupHealth {
  lastBackup:   Date | null;
  lastStatus:   string | null;
  lastSizeKB:   number | null;
  totalBackups: number;
  oldestBackup: Date | null;
  verified:     boolean;
  nextRunAt:    Date;
}

export async function getBackupHealth(): Promise<BackupHealth> {
  const db = getSharedPool();

  const latest = await db.query<{
    started_at: Date; status: string; file_size_kb: number | null; verified: boolean;
  }>(
    `SELECT started_at, status, file_size_kb, verified
     FROM public.db_backup_log ORDER BY started_at DESC LIMIT 1`
  );

  const count = await db.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM public.db_backup_log WHERE status = 'success'`
  );

  const oldest = await db.query<{ started_at: Date }>(
    `SELECT started_at FROM public.db_backup_log
     WHERE status = 'success' ORDER BY started_at ASC LIMIT 1`
  );

  const row = latest.rows[0];
  return {
    lastBackup:   row?.started_at   ?? null,
    lastStatus:   row?.status       ?? null,
    lastSizeKB:   row?.file_size_kb ?? null,
    totalBackups: parseInt(count.rows[0]?.count ?? '0', 10),
    oldestBackup: oldest.rows[0]?.started_at ?? null,
    verified:     row?.verified ?? false,
    nextRunAt:    new Date(Date.now() + msUntilNextRun()),
  };
}

// ─── List recent backup history ───────────────────────────────────────────────

export async function listBackupHistory(limit = 10): Promise<Array<{
  id: number; startedAt: Date; finishedAt: Date | null;
  status: string; fileSizeKB: number | null; verified: boolean; errorMessage: string | null;
}>> {
  const db  = getSharedPool();
  const res = await db.query<{
    id: number; started_at: Date; finished_at: Date | null;
    status: string; file_size_kb: number | null; verified: boolean; error_message: string | null;
  }>(
    `SELECT id, started_at, finished_at, status, file_size_kb, verified, error_message
     FROM public.db_backup_log ORDER BY started_at DESC LIMIT $1`,
    [limit]
  );
  return res.rows.map(r => ({
    id:           r.id,
    startedAt:    r.started_at,
    finishedAt:   r.finished_at,
    status:       r.status,
    fileSizeKB:   r.file_size_kb,
    verified:     r.verified,
    errorMessage: r.error_message,
  }));
}

// ─── Scheduler ────────────────────────────────────────────────────────────────

let schedulerTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleNextRun(): void {
  const ms = msUntilNextRun();
  logger.info(
    { nextRunAt: new Date(Date.now() + ms).toISOString() },
    'backupScheduler: next backup scheduled'
  );
  schedulerTimer = setTimeout(async () => {
    try {
      await runBackup();
    } catch (err) {
      logger.error({ err: String(err) }, 'backupScheduler: scheduled run failed');
    }
    scheduleNextRun();
  }, ms);

  // Prevent the timer from blocking process exit
  schedulerTimer.unref?.();
}

export function startBackupScheduler(): void {
  if (schedulerTimer) return;
  logger.info('backupScheduler: initialising');
  scheduleNextRun();
}

export function stopBackupScheduler(): void {
  if (schedulerTimer) {
    clearTimeout(schedulerTimer);
    schedulerTimer = null;
  }
}
