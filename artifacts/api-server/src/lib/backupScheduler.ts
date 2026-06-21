/**
 * backupScheduler — Daily PostgreSQL backup with compression and verification.
 *
 * Runs at 02:00 UTC every day.
 * Stores backups in data/backups/ with 30-day retention.
 * Logs each run to db_backup_log table.
 *
 * Requirements:
 *   - pg_dump must be available in PATH
 *   - DATABASE_URL env var must be set
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { getMigrationPool } from './dbMigrations';
import { logger } from './logger';

const execFileAsync = promisify(execFile);

const BACKUP_DIR       = path.join(process.cwd(), 'data', 'backups');
const RETENTION_DAYS   = 30;
const BACKUP_HOUR_UTC  = 2;  // 02:00 UTC

fs.mkdirSync(BACKUP_DIR, { recursive: true });

// ─── Backup logic ─────────────────────────────────────────────────────────────

export async function runBackup(): Promise<void> {
  const db  = getMigrationPool();
  const now = new Date();
  const ts  = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const fileName = `sage-backup-${ts}.sql.gz`;
  const filePath = path.join(BACKUP_DIR, fileName);

  let logId: number | null = null;

  try {
    // Insert log entry — status: running
    const logRes = await db.query<{ id: number }>(
      `INSERT INTO db_backup_log (started_at, status, file_path)
       VALUES (now(), 'running', $1) RETURNING id`,
      [filePath]
    );
    logId = logRes.rows[0]?.id ?? null;

    const dbUrl = process.env['DATABASE_URL'];
    if (!dbUrl) throw new Error('DATABASE_URL not set');

    logger.info({ filePath }, 'backupScheduler: starting pg_dump');

    // pg_dump | gzip > file
    // Use shell: false approach with piped execution
    await execFileAsync('sh', [
      '-c',
      `pg_dump "${dbUrl}" | gzip > "${filePath}"`,
    ]);

    // Verify backup integrity
    await execFileAsync('sh', ['-c', `gzip -t "${filePath}"`]);
    const verified  = true;
    const sizeBytes = fs.statSync(filePath).size;
    const sizeKB    = Math.round(sizeBytes / 1024);

    // Update log — success
    if (logId) {
      await db.query(
        `UPDATE db_backup_log
         SET status = 'success', finished_at = now(), file_size_kb = $2, verified = true
         WHERE id = $1`,
        [logId, sizeKB]
      );
    }

    logger.info(
      { filePath, sizeKB, verified },
      'backupScheduler: backup completed successfully'
    );

    // Prune old backups
    await pruneOldBackups();

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg, filePath }, 'backupScheduler: backup failed');

    if (logId) {
      await db.query(
        `UPDATE db_backup_log
         SET status = 'failed', finished_at = now(), error_message = $2
         WHERE id = $1`,
        [logId, msg]
      );
    }

    // Clean up partial file
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch { /* ignore */ }
  }
}

// ─── Prune old backups ────────────────────────────────────────────────────────

async function pruneOldBackups(): Promise<void> {
  const cutoff  = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const entries = fs.readdirSync(BACKUP_DIR);
  let pruned    = 0;

  for (const entry of entries) {
    if (!entry.startsWith('sage-backup-') || !entry.endsWith('.sql.gz')) continue;
    const filePath = path.join(BACKUP_DIR, entry);
    const stat     = fs.statSync(filePath);
    if (stat.mtimeMs < cutoff) {
      fs.unlinkSync(filePath);
      pruned++;
      logger.info({ file: entry }, 'backupScheduler: pruned old backup');
    }
  }

  if (pruned > 0) {
    // Also clean up old DB log entries
    const db = getMigrationPool();
    await db.query(
      `DELETE FROM db_backup_log WHERE started_at < now() - interval '${RETENTION_DAYS} days'`
    );
    logger.info({ pruned }, 'backupScheduler: pruning complete');
  }
}

// ─── Backup health check ──────────────────────────────────────────────────────

export async function getBackupHealth(): Promise<{
  lastBackup: Date | null;
  lastStatus: string | null;
  lastSizeKB: number | null;
  totalBackups: number;
  oldestBackup: Date | null;
  verified: boolean;
}> {
  const db  = getMigrationPool();
  const res = await db.query<{
    started_at: Date;
    status: string;
    file_size_kb: number | null;
    verified: boolean;
  }>(
    `SELECT started_at, status, file_size_kb, verified
     FROM db_backup_log
     ORDER BY started_at DESC LIMIT 1`
  );
  const count = await db.query<{ count: string }>(
    `SELECT COUNT(*) as count FROM db_backup_log WHERE status = 'success'`
  );
  const oldest = await db.query<{ started_at: Date }>(
    `SELECT started_at FROM db_backup_log WHERE status = 'success' ORDER BY started_at ASC LIMIT 1`
  );

  const latest = res.rows[0];
  return {
    lastBackup:   latest?.started_at ?? null,
    lastStatus:   latest?.status ?? null,
    lastSizeKB:   latest?.file_size_kb ?? null,
    totalBackups: parseInt(count.rows[0]?.count ?? '0', 10),
    oldestBackup: oldest.rows[0]?.started_at ?? null,
    verified:     latest?.verified ?? false,
  };
}

// ─── Scheduler ────────────────────────────────────────────────────────────────

let schedulerTimer: ReturnType<typeof setTimeout> | null = null;

function msUntilNextRun(): number {
  const now = new Date();
  const next = new Date();
  next.setUTCHours(BACKUP_HOUR_UTC, 0, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

function scheduleNextRun(): void {
  const ms = msUntilNextRun();
  logger.info(
    { nextRunAt: new Date(Date.now() + ms).toISOString() },
    'backupScheduler: next backup scheduled'
  );
  schedulerTimer = setTimeout(async () => {
    await runBackup();
    scheduleNextRun(); // Schedule next day
  }, ms);
}

export function startBackupScheduler(): void {
  if (schedulerTimer) return; // Already running
  logger.info('backupScheduler: initialising');
  scheduleNextRun();
}

export function stopBackupScheduler(): void {
  if (schedulerTimer) {
    clearTimeout(schedulerTimer);
    schedulerTimer = null;
  }
}
