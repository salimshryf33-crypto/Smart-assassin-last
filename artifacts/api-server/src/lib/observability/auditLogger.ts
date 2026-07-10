/**
 * lib/observability/auditLogger.ts
 *
 * Phase 5 — Structured audit logging for the validation pipeline.
 *
 * Every call:
 *   1. Emits a structured pino JSON log line (traceId, requestId, etc.)
 *   2. Writes an append-only row to public.validation_audit_log
 *
 * Writes are fire-and-forget (never block the validation hot path) —
 * consistent with the existing weaknessAnalyzer fire-and-forget pattern.
 */
import { getSharedPool } from '../dbPool';
import { logger } from '../logger';
import { v4 as uuidv4 } from 'uuid';

export interface AuditEvent {
  traceId?:      string;
  requestId?:    string;
  validationId?: string;
  workerId?:     string;
  examId?:       string;
  questionId?:   string;
  event:         string;
  severity:      'info' | 'warn' | 'error';
  durationMs?:   number;
  payload?:      Record<string, unknown>;
}

const WORKER_ID = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

export function logAuditEvent(evt: AuditEvent): void {
  const record = {
    traceId:      evt.traceId ?? uuidv4(),
    requestId:    evt.requestId ?? null,
    validationId: evt.validationId ?? null,
    workerId:     evt.workerId ?? WORKER_ID,
    examId:       evt.examId ?? null,
    questionId:   evt.questionId ?? null,
    timestamp:    new Date().toISOString(),
    duration:     evt.durationMs ?? null,
    severity:     evt.severity,
    component:    'validationPipeline',
    event:        evt.event,
    payload:      evt.payload ?? {},
  };

  // 1. Structured JSON log line
  logger[evt.severity === 'error' ? 'error' : evt.severity === 'warn' ? 'warn' : 'info'](
    record,
    `audit: ${evt.event}`,
  );

  // 2. Fire-and-forget durable write — never throws into the caller
  void persistAuditEvent(record).catch((err: unknown) => {
    logger.error({ err }, 'auditLogger: failed to persist audit event');
  });
}

async function persistAuditEvent(record: {
  traceId: string; requestId: string | null; validationId: string | null;
  workerId: string; examId: string | null; questionId: string | null;
  timestamp: string; duration: number | null; severity: string; component: string;
  event: string; payload: Record<string, unknown>;
}): Promise<void> {
  const pool = getSharedPool();
  await pool.query(
    `INSERT INTO public.validation_audit_log
       (id, trace_id, request_id, validation_id, worker_id, exam_id, question_id,
        event, severity, duration_ms, payload, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())`,
    [
      uuidv4(),
      record.traceId,
      record.requestId,
      record.validationId,
      record.workerId,
      record.examId,
      record.questionId,
      record.event,
      record.severity,
      record.duration,
      JSON.stringify(record.payload),
    ],
  );
}
