import { getAuth } from 'firebase/auth';

async function authHeaders(): Promise<HeadersInit> {
  try {
    const user = getAuth().currentUser;
    if (!user) return {};
    const token = await user.getIdToken();
    return { Authorization: `Bearer ${token}` };
  } catch {
    return {};
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SystemHealth {
  status: 'healthy' | 'degraded';
  timestamp: string;
  server: {
    uptimeSeconds: number;
    nodeVersion: string;
    platform: string;
    memory: { heapUsedMB: number; heapTotalMB: number; rssMB: number };
    cpus: number;
    loadAvg: number[];
  };
  database: {
    connected: boolean;
    serverTime: string | null;
    auditEntries: number;
    rateBuckets: number;
    assignedRoles: number;
  };
  backup: {
    lastRun: string | null;
    lastStatus: string | null;
    lastSizeKB: number | null;
    totalRuns: number;
  };
  security: {
    rateLimitingEnabled: boolean;
    pdfValidationEnabled: boolean;
    rbacEnabled: boolean;
    auditLogEnabled: boolean;
    securityHeadersEnabled: boolean;
  };
}

export interface AuditEntry {
  id: number;
  uid: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  metadata: Record<string, unknown> | null;
  ip_address: string | null;
  request_id: string | null;
  created_at: string;
}

export interface AuditLogResponse {
  total: number;
  entries: AuditEntry[];
}

// ─── API calls ────────────────────────────────────────────────────────────────

export async function fetchSystemHealth(): Promise<SystemHealth> {
  const res = await fetch('/api/admin/system-health', { headers: await authHeaders() });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

export async function fetchAuditLog(opts?: { limit?: number; uid?: string; action?: string }): Promise<AuditLogResponse> {
  const params = new URLSearchParams();
  if (opts?.limit)  params.set('limit',  String(opts.limit));
  if (opts?.uid)    params.set('uid',    opts.uid);
  if (opts?.action) params.set('action', opts.action);
  const qs = params.toString() ? `?${params.toString()}` : '';
  const res = await fetch(`/api/admin/audit-log${qs}`, { headers: await authHeaders() });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

export async function triggerBackup(): Promise<void> {
  const res = await fetch('/api/admin/backup/run', {
    method: 'POST',
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
}
