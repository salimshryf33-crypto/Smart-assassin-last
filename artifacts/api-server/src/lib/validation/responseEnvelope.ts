/**
 * lib/validation/responseEnvelope.ts
 *
 * Phase 5 — Observability Layer.
 *
 * Standard response envelope for all NEW observability / integrity endpoints.
 * Does NOT change the response shape of any existing route — additive only.
 *
 * Shape:
 *   { success, errorCode, message, details, timestamp }
 */

export interface SuccessEnvelope<T> {
  success:   true;
  errorCode: null;
  message:   string;
  details:   T;
  timestamp: string;
}

export interface ErrorEnvelope {
  success:   false;
  errorCode: string;
  message:   string;
  details:   unknown;
  timestamp: string;
}

export type ResponseEnvelope<T> = SuccessEnvelope<T> | ErrorEnvelope;

export function ok<T>(details: T, message = 'ok'): SuccessEnvelope<T> {
  return {
    success:   true,
    errorCode: null,
    message,
    details,
    timestamp: new Date().toISOString(),
  };
}

export function fail(
  errorCode: string,
  message:   string,
  details:   unknown = null,
): ErrorEnvelope {
  return {
    success: false,
    errorCode,
    message,
    details,
    timestamp: new Date().toISOString(),
  };
}
