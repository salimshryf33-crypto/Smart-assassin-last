/**
 * lib/observability/healthEndpoints.ts
 *
 * Phase 5 — Extended readiness check.
 * Read-only — never mutates state. Uses the shared pool only (no new pools).
 */
import { getSharedPool, getPoolStats } from '../dbPool';
import { logger } from '../logger';

export interface HealthReport {
  status: 'ok' | 'degraded' | 'down';
  db: { connected: boolean; poolStats: ReturnType<typeof getPoolStats> };
  timestamp: string;
}

export async function checkHealth(): Promise<HealthReport> {
  let dbConnected = false;
  try {
    const pool = getSharedPool();
    await pool.query('SELECT 1');
    dbConnected = true;
  } catch (err) {
    logger.error({ err }, 'healthEndpoints: DB check failed');
  }

  return {
    status: dbConnected ? 'ok' : 'down',
    db: { connected: dbConnected, poolStats: getPoolStats() },
    timestamp: new Date().toISOString(),
  };
}
