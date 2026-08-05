import { getAuth } from 'firebase/auth';
import { getAppCheckToken } from '../lib/appCheckToken';

async function authHeaders(): Promise<HeadersInit> {
  try {
    const user = getAuth().currentUser;
    if (!user) return {};
    const [token, acToken] = await Promise.all([user.getIdToken(), getAppCheckToken()]);
    const h: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (acToken) h['X-Firebase-AppCheck'] = acToken;
    return h;
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

export interface MetricsSnapshot {
  generatedAt: string;
  uptime: { startedAt: string; uptimeSeconds: number };
  requests: { total: number; active: number; errors: number };
  gemini: {
    callsToday: number;
    callsTotal: number;
    failures: number;
    quotaErrors: number;
    avgResponseMs: number;
    successRate: number;
  };
  search: {
    total: number;
    avgLatencyMs: number;
    topSubjects: Array<{ name: string; count: number }>;
    topGrades:   Array<{ name: string; count: number }>;
  };
}

export interface UsageSummary {
  generatedAt: string;
  curriculum: {
    totalDocs: number;
    books: number;
    examDocs: number;
    totalChunks: number;
  };
  ocr: { done: number; processing: number; failed: number };
  storage: { pdfCount: number; pdfSizeKB: number; pdfSizeMB: number };
  exams: {
    byStatus: Record<string, number>;
    totalDone: number;
    totalPending: number;
    totalError: number;
    questionsExtracted: number;
  };
  search: {
    total: number;
    avgLatencyMs: number;
    topSubjects: Array<{ name: string; count: number }>;
    topGrades:   Array<{ name: string; count: number }>;
  };
}

export interface CacheMetrics {
  generatedAt: string;
  backend: string;
  connected: boolean;
  hits: number;
  misses: number;
  errors: number;
  hitRatioPct: number;
  setOps: number;
  invalidations: number;
  savedGeminiCalls: number;
  inFlightKeys: number;
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

export async function fetchMetrics(): Promise<MetricsSnapshot> {
  const res = await fetch('/api/admin/metrics', { headers: await authHeaders() });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

export async function fetchUsageSummary(): Promise<UsageSummary> {
  const res = await fetch('/api/admin/usage-summary', { headers: await authHeaders() });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

export async function fetchCacheMetrics(): Promise<CacheMetrics> {
  const res = await fetch('/api/admin/cache-metrics', { headers: await authHeaders() });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

// ─── Preparation Operations Dashboard ────────────────────────────────────────

export interface PrepOpsRunningJob {
  jobId:          string;
  examId:         string;
  examTitle:      string;
  status:         string;
  totalQuestions: number;
  readyQuestions: number;
  progressPct:    number;
  startedAt:      string | null;
  heartbeat:      string | null;
  workerId:       string | null;
  currentStage:   string;
}

export interface PrepOpsExamRow {
  examId:            string;
  title:             string;
  totalQuestions:    number;
  mcqQuestions:      number;
  ready:             number;
  validated:         number;
  lowEvidence:       number;
  permanentLow:      number;
  pending:           number;
  processing:        number;
  invalid:           number;
  completionPct:     number;
  preparationStatus: string;
  lastUpdated:       string | null;
}

export interface PrepOpsEvent {
  id:         string;
  event:      string;
  examId:     string | null;
  questionId: string | null;
  severity:   string;
  createdAt:  string;
  payload:    Record<string, unknown>;
}

// ─── Scheduler state types ────────────────────────────────────────────────────

export interface PrepOpsSchedulerActiveExam {
  jobId:              string;
  examId:             string;
  examTitle:          string;
  status:             string;
  priority:           number;
  readyQuestions:     number;
  totalQuestions:     number;
  progressPct:        number;
  remainingQuestions: number;
  startedAt:          string | null;
  heartbeat:          string | null;
}

export interface PrepOpsQueueOrderEntry {
  position:           number;
  jobId:              string;
  examId:             string;
  examTitle:          string;
  status:             string;
  priority:           number;
  readyQuestions:     number;
  totalQuestions:     number;
  progressPct:        number;
  remainingQuestions: number;
}

export interface PrepOpsSchedulerState {
  mode:           'sequential';
  status:         'running' | 'idle' | 'quota_paused';
  activeExam:     PrepOpsSchedulerActiveExam | null;
  queueOrder:     PrepOpsQueueOrderEntry[];
  nextExamPreview: { examId: string; examTitle: string; progressPct: number } | null;
}

export interface PrepOpsDashboard {
  generatedAt: string;
  globalSummary: {
    totalBooks:     number;
    totalExams:     number;
    totalQuestions: number;
  };
  preparationStatus: {
    counts:      Record<string, number>;
    total:       number;
    percentages: Record<string, number>;
  };
  queueStatus: {
    active:  number;
    waiting: number;
    paused:  number;
    retry:   number;
    done:    number;
    failed:  number;
    dlq:     number;
  };
  geminiStatus: {
    provider:       string;
    callsToday:     number;
    quotaErrors:    number;
    lastActivity:   string | null;
    lastQuotaError: string | null;
    isActive:       boolean;
  };
  runningJobs:  PrepOpsRunningJob[];
  examTable:    PrepOpsExamRow[];
  orphanCount:  number;
  recentEvents: PrepOpsEvent[];
  healthStatus: 'healthy' | 'quota_wait' | 'active_recovery' | 'stalled';
  scheduler?:   PrepOpsSchedulerState;
}

export async function fetchPrepOps(): Promise<PrepOpsDashboard> {
  const res = await fetch('/api/admin/prep-ops', { headers: await authHeaders() });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}
