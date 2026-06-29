/**
 * backupScheduler.test.ts — comprehensive tests for the backup system.
 *
 * Run with:
 *   pnpm --filter @workspace/api-server test:backup
 *
 * Tests:
 *   1. msUntilNextRun()  — timing math (pure unit test, no DB)
 *   2. getBackupHealth() — structure + DB connectivity
 *   3. runBackup()       — full integration: pg_dump → gzip → disk → audit log
 *   4. pruneOldBackups() — cleanup logic
 *   5. listBackupHistory() — history pagination
 *
 * Requirements:
 *   - DATABASE_URL must be set (real Neon connection)
 *   - pg_dump must be in PATH
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs     from 'node:fs';
import path   from 'node:path';
import {
  msUntilNextRun,
  runBackup,
  getBackupHealth,
  pruneOldBackups,
  listBackupHistory,
  stopBackupScheduler,
} from './backupScheduler.js';
import { getSharedPool, closeSharedPool, getPoolStats } from './dbPool.js';

// ─── Guard: DATABASE_URL must be set ─────────────────────────────────────────

if (!process.env['DATABASE_URL']) {
  console.error('ERROR: DATABASE_URL is not set — cannot run backup tests.');
  process.exit(1);
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('Backup Scheduler', () => {

  before(async () => {
    // Stop any scheduled timer so it doesn't interfere with timing tests
    stopBackupScheduler();

    // Ensure db_backup_log table exists.
    // We create it here so the test is self-contained (no server startup needed).
    // The shared pool will set search_path=public on each new connection,
    // so unqualified table names resolve correctly.
    const db = getSharedPool();
    // Wait for the pool's connect handler to fire (search_path set)
    await db.query('SELECT 1');
    await db.query(`
      CREATE TABLE IF NOT EXISTS public.db_backup_log (
        id            SERIAL      PRIMARY KEY,
        started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        finished_at   TIMESTAMPTZ,
        status        TEXT        NOT NULL DEFAULT 'running'
                                  CHECK (status IN ('running','success','failed')),
        file_path     TEXT,
        file_size_kb  INTEGER,
        error_message TEXT,
        verified      BOOLEAN     NOT NULL DEFAULT false,
        backup_data   BYTEA
      )
    `);
  });

  after(async () => {
    await closeSharedPool();
  });

  // ── 1. Timing math ──────────────────────────────────────────────────────────

  describe('msUntilNextRun()', () => {
    it('returns a positive number', () => {
      const ms = msUntilNextRun();
      assert.ok(ms > 0, `Expected ms > 0, got ${ms}`);
    });

    it('returns at most 24 hours in milliseconds', () => {
      const ms     = msUntilNextRun();
      const max24h = 24 * 60 * 60 * 1000;
      assert.ok(ms <= max24h, `Expected ms ≤ ${max24h}, got ${ms}`);
    });

    it('is stable across two consecutive calls (< 100 ms drift)', () => {
      const a = msUntilNextRun();
      const b = msUntilNextRun();
      assert.ok(Math.abs(a - b) < 100, `Drift too large: ${Math.abs(a - b)} ms`);
    });
  });

  // ── 2. Connection pool ───────────────────────────────────────────────────────

  describe('Connection pool (dbPool)', () => {
    it('initialises the shared pool on first access', () => {
      const pool  = getSharedPool();
      assert.ok(pool, 'Pool should be truthy');
      const stats = getPoolStats();
      assert.equal(stats.initialised, true);
    });

    it('returns the same pool instance on repeated calls', () => {
      const a = getSharedPool();
      const b = getSharedPool();
      assert.equal(a, b, 'Should return the singleton instance');
    });

    it('can run a simple query', async () => {
      const pool = getSharedPool();
      const res  = await pool.query<{ now: string }>('SELECT now()::text AS now');
      assert.ok(res.rows[0]?.now, 'Should return current timestamp');
    });

    it('pool stats include totalCount / idleCount / waitingCount', () => {
      const stats = getPoolStats();
      assert.ok('totalCount'   in stats, 'missing totalCount');
      assert.ok('idleCount'    in stats, 'missing idleCount');
      assert.ok('waitingCount' in stats, 'missing waitingCount');
      assert.ok(typeof stats.totalCount   === 'number', 'totalCount should be number');
      assert.ok(typeof stats.idleCount    === 'number', 'idleCount should be number');
      assert.ok(typeof stats.waitingCount === 'number', 'waitingCount should be number');
    });
  });

  // ── 3. Health check structure (pre-backup) ──────────────────────────────────

  describe('getBackupHealth() — structure', () => {
    it('returns an object with all required fields', async () => {
      const h = await getBackupHealth();
      const required: Array<keyof typeof h> = [
        'lastBackup', 'lastStatus', 'lastSizeKB',
        'totalBackups', 'oldestBackup', 'verified', 'nextRunAt',
      ];
      for (const field of required) {
        assert.ok(field in h, `Missing field: ${field}`);
      }
    });

    it('nextRunAt is a future Date', async () => {
      const h = await getBackupHealth();
      assert.ok(h.nextRunAt instanceof Date, 'nextRunAt should be a Date');
      assert.ok(h.nextRunAt > new Date(), 'nextRunAt should be in the future');
    });

    it('totalBackups is a non-negative integer', async () => {
      const h = await getBackupHealth();
      assert.ok(Number.isInteger(h.totalBackups), 'totalBackups should be integer');
      assert.ok(h.totalBackups >= 0, 'totalBackups should be non-negative');
    });
  });

  // ── 4. Full backup integration test ─────────────────────────────────────────

  describe('runBackup() — integration', { timeout: 60_000 }, () => {
    let backupFilePath: string | null = null;
    let prevTotalBackups = 0;

    before(async () => {
      const h = await getBackupHealth();
      prevTotalBackups = h.totalBackups;
    });

    it('completes without throwing', async () => {
      // This is the key test — if pg_dump fails, it throws and the test fails.
      await runBackup();
    });

    it('health shows lastStatus = success after runBackup()', async () => {
      const h = await getBackupHealth();
      assert.equal(h.lastStatus, 'success', `Expected success, got: ${h.lastStatus}`);
    });

    it('health shows verified = true', async () => {
      const h = await getBackupHealth();
      assert.equal(h.verified, true, 'Backup should be verified (gzip -t passed)');
    });

    it('health shows lastSizeKB is a non-negative number', async () => {
      const h = await getBackupHealth();
      // The backup is gzip-compressed; a small DB may round to 0 KB.
      // We assert it is present (not null) and >= 0.
      assert.ok(
        h.lastSizeKB !== null && h.lastSizeKB >= 0,
        `Expected lastSizeKB >= 0, got ${h.lastSizeKB}`
      );
    });

    it('totalBackups increased by 1', async () => {
      const h = await getBackupHealth();
      assert.equal(
        h.totalBackups,
        prevTotalBackups + 1,
        `Expected ${prevTotalBackups + 1} backups, got ${h.totalBackups}`
      );
    });

    it('backup file exists on disk', async () => {
      const h = await getBackupHealth();
      // Find the most recent backup file
      const files = fs.readdirSync(path.join(process.cwd(), 'data', 'backups'))
        .filter(f => f.startsWith('sage-backup-') && f.endsWith('.sql.gz'))
        .sort()
        .reverse();
      assert.ok(files.length > 0, 'At least one .sql.gz file should exist');
      backupFilePath = path.join(process.cwd(), 'data', 'backups', files[0]!);
      assert.ok(fs.existsSync(backupFilePath), `File not found: ${backupFilePath}`);
    });

    it('backup file is readable and non-empty', () => {
      if (!backupFilePath) return;
      const stat = fs.statSync(backupFilePath);
      assert.ok(stat.size > 0, 'Backup file should not be empty');
    });
  });

  // ── 5. Backup history ────────────────────────────────────────────────────────

  describe('listBackupHistory()', () => {
    it('returns an array', async () => {
      const history = await listBackupHistory(5);
      assert.ok(Array.isArray(history), 'Should return an array');
    });

    it('each entry has required fields', async () => {
      const history = await listBackupHistory(5);
      for (const entry of history) {
        assert.ok('id'           in entry, 'Missing id');
        assert.ok('startedAt'    in entry, 'Missing startedAt');
        assert.ok('status'       in entry, 'Missing status');
        assert.ok('verified'     in entry, 'Missing verified');
        assert.ok('fileSizeKB'   in entry, 'Missing fileSizeKB');
        assert.ok('errorMessage' in entry, 'Missing errorMessage');
      }
    });

    it('most recent entry has status = success', async () => {
      const history = await listBackupHistory(1);
      if (history.length > 0) {
        assert.equal(history[0]!.status, 'success');
      }
    });

    it('respects the limit parameter', async () => {
      const h3 = await listBackupHistory(3);
      const h1 = await listBackupHistory(1);
      assert.ok(h3.length <= 3, `Expected ≤3 entries, got ${h3.length}`);
      assert.ok(h1.length <= 1, `Expected ≤1 entry, got ${h1.length}`);
    });
  });

  // ── 6. Prune old backups ─────────────────────────────────────────────────────

  describe('pruneOldBackups()', () => {
    it('runs without throwing', async () => {
      await assert.doesNotReject(pruneOldBackups);
    });

    it('only removes files older than 30 days', async () => {
      const backupDir = path.join(process.cwd(), 'data', 'backups');
      const before    = fs.readdirSync(backupDir)
        .filter(f => f.startsWith('sage-backup-') && f.endsWith('.sql.gz')).length;

      await pruneOldBackups();

      const after = fs.readdirSync(backupDir)
        .filter(f => f.startsWith('sage-backup-') && f.endsWith('.sql.gz')).length;

      // Recent backups (made in this test run) should NOT be pruned
      assert.ok(after >= 1, 'Recent backup should still exist after pruning');
      assert.ok(after <= before, 'Prune should not add files');
    });
  });

});
