/**
 * auditLog — Structured audit trail for sensitive operations.
 *
 * All writes are fire-and-forget — never blocks the request path.
 * Errors are logged as warnings but never propagated.
 *
 * Usage:
 *   import { audit } from '../lib/auditLog';
 *   audit({ uid: req.user?.uid, action: 'pdf_upload', resourceId: docId, req });
 *
 * Table: audit_log (created by dbMigrations)
 */
import type { Request } from 'express';
import { getMigrationPool } from './dbMigrations';
import { logger } from './logger';

// ─── Action registry ──────────────────────────────────────────────────────────

export type AuditAction =
  | 'pdf_upload'
  | 'doc_delete'
  | 'doc_reindex'
  | 'exam_create'
  | 'exam_delete'
  | 'exam_solve_start'
  | 'exam_solve_complete'
  | 'role_grant'
  | 'role_revoke'
  | 'admin_claim_set'
  | 'backup_run'
  | 'rate_limit_reset'
  | 'extraction_trigger'
  | 'cache_clear';

// ─── Entry shape ──────────────────────────────────────────────────────────────

export interface AuditEntry {
  uid?:          string | null;
  action:        AuditAction;
  resourceType?: string;
  resourceId?:   string;
  metadata?:     Record<string, unknown>;
  /** Attach the Express request to auto-extract IP and X-Request-ID */
  req?:          Request;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Write an audit entry. Fire-and-forget — always safe to call mid-request.
 */
export function audit(entry: AuditEntry): void {
  const ipAddress = entry.req
    ? ((entry.req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim()
        ?? entry.req.socket?.remoteAddress
        ?? null)
    : null;

  const requestIdVal = entry.req?.requestId ?? null;

  const db = getMigrationPool();
  db.query(
    `INSERT INTO public.audit_log
       (uid, action, resource_type, resource_id, metadata, ip_address, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      entry.uid ?? null,
      entry.action,
      entry.resourceType ?? null,
      entry.resourceId   ?? null,
      entry.metadata     ? JSON.stringify(entry.metadata) : null,
      ipAddress,
      requestIdVal,
    ]
  ).catch(err =>
    logger.warn({ err, action: entry.action }, 'auditLog: write failed — non-fatal')
  );
}

// ─── Admin query helpers ──────────────────────────────────────────────────────

export interface AuditRow {
  id:           number;
  uid:          string | null;
  action:       string;
  resourceType: string | null;
  resourceId:   string | null;
  metadata:     Record<string, unknown> | null;
  ipAddress:    string | null;
  requestId:    string | null;
  createdAt:    Date;
}

/** Fetch the most recent N audit entries, optionally filtered by uid or action. */
export async function listAuditLog(opts: {
  limit?:  number;
  uid?:    string;
  action?: AuditAction;
}): Promise<AuditRow[]> {
  const db     = getMigrationPool();
  const limit  = Math.min(opts.limit ?? 100, 500);
  const where: string[] = [];
  const params: unknown[] = [];

  if (opts.uid)    { params.push(opts.uid);    where.push(`uid = $${params.length}`); }
  if (opts.action) { params.push(opts.action); where.push(`action = $${params.length}`); }

  params.push(limit);
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const res = await db.query<{
    id: number; uid: string | null; action: string;
    resource_type: string | null; resource_id: string | null;
    metadata: Record<string, unknown> | null; ip_address: string | null;
    request_id: string | null; created_at: Date;
  }>(
    `SELECT id, uid, action, resource_type, resource_id, metadata,
            ip_address, request_id, created_at
     FROM public.audit_log
     ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${params.length}`,
    params
  );

  return res.rows.map(r => ({
    id:           r.id,
    uid:          r.uid,
    action:       r.action,
    resourceType: r.resource_type,
    resourceId:   r.resource_id,
    metadata:     r.metadata,
    ipAddress:    r.ip_address,
    requestId:    r.request_id,
    createdAt:    r.created_at,
  }));
}
