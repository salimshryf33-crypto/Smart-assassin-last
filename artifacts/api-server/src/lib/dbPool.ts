/**
 * dbPool — single shared PostgreSQL connection pool for the entire API server.
 *
 * All modules must import getSharedPool() from here instead of creating
 * their own pg.Pool instances.
 *
 * Tuned for Neon PostgreSQL:
 *   - max: 10  (Neon free tier allows 25; we stay well under)
 *   - keepAlive: true  (Neon closes idle connections after ~5 min)
 *   - idleTimeoutMillis: 30 000  (release idle connections before Neon does)
 *   - connectionTimeoutMillis: 10 000  (fail fast if pool is exhausted)
 *
 * Note: all SQL queries that touch tables must use schema-qualified names
 * (e.g. public.table_name) rather than relying on search_path, because
 * Neon roles may have an empty default search_path.
 */
import { Pool } from 'pg';
import { logger } from './logger';

let _pool: Pool | null = null;

export function getSharedPool(): Pool {
  if (_pool) return _pool;

  const url = process.env['NEON_DATABASE_URL'] ?? process.env['DATABASE_URL'];
  if (!url) throw new Error('NEON_DATABASE_URL or DATABASE_URL not set');

  _pool = new Pool({
    connectionString:        url,
    max:                     10,
    idleTimeoutMillis:       30_000,
    connectionTimeoutMillis: 10_000,
    keepAlive:               true,
    keepAliveInitialDelayMillis: 10_000,
  });

  _pool.on('connect', () => {
    logger.debug('dbPool: new client connected');
  });

  _pool.on('error', (err) => {
    logger.error({ err: err.message }, 'dbPool: idle client error');
  });

  logger.info(
    { max: 10, idleTimeoutMs: 30_000, keepAlive: true },
    'dbPool: shared pool initialised'
  );

  return _pool;
}

/** Graceful shutdown — call on SIGTERM. */
export async function closeSharedPool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
    logger.info('dbPool: pool closed');
  }
}

/** Returns a snapshot of current pool stats (for health checks). */
export function getPoolStats() {
  if (!_pool) return { initialised: false };
  return {
    initialised:  true,
    totalCount:   _pool.totalCount,
    idleCount:    _pool.idleCount,
    waitingCount: _pool.waitingCount,
  };
}
