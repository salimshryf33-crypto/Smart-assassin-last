/**
 * lib/observability/metricsCollector.ts
 *
 * Phase 5 — Aggregated validation metrics, stored in PostgreSQL
 * (never memory-only, per the Database Contract).
 *
 * Design: an in-process accumulator buffers per-question timing samples for
 * the CURRENT hour bucket, then flushes an UPSERT into
 * public.validation_metrics_hourly on every flush() call (called after each
 * validationPipeline run and by a periodic timer). This avoids one DB write
 * per question while still guaranteeing durability within a bounded window.
 */
import { getSharedPool } from '../dbPool';
import { logger } from '../logger';

interface Sample {
  validationMs?: number;
  retrievalMs?:  number;
  geminiMs?:     number;
  outcome:       'ready' | 'retry' | 'invalid' | 'low_evidence';
}

interface BucketAccumulator {
  bucketStart: string; // ISO hour bucket
  count: number;
  validationMsSum: number;
  validationMsN: number;
  retrievalMsSum: number;
  retrievalMsN: number;
  geminiMsSum: number;
  geminiMsN: number;
  ready: number;
  retry: number;
  invalid: number;
  lowEvidence: number;
}

let current: BucketAccumulator | null = null;
let flushInFlight = false;

function hourBucket(date: Date): string {
  const d = new Date(date);
  d.setMinutes(0, 0, 0);
  return d.toISOString();
}

function emptyBucket(bucketStart: string): BucketAccumulator {
  return {
    bucketStart, count: 0,
    validationMsSum: 0, validationMsN: 0,
    retrievalMsSum: 0, retrievalMsN: 0,
    geminiMsSum: 0, geminiMsN: 0,
    ready: 0, retry: 0, invalid: 0, lowEvidence: 0,
  };
}

function getOrCreateBucket(): BucketAccumulator {
  const bucketStart = hourBucket(new Date());
  if (!current) {
    current = emptyBucket(bucketStart);
  } else if (current.bucketStart !== bucketStart) {
    // New hour started — flush the previous bucket's samples, then start a
    // fresh accumulator for the new hour (samples are swapped out first so
    // the periodic timer's flush() can never re-persist them).
    const previous = current;
    current = emptyBucket(bucketStart);
    void flush(previous);
  }
  return current;
}

/** Record one question-level validation outcome. Never throws. */
export function recordSample(sample: Sample): void {
  try {
    const bucket = getOrCreateBucket();
    bucket.count++;
    if (sample.validationMs !== undefined) { bucket.validationMsSum += sample.validationMs; bucket.validationMsN++; }
    if (sample.retrievalMs  !== undefined) { bucket.retrievalMsSum  += sample.retrievalMs;  bucket.retrievalMsN++; }
    if (sample.geminiMs     !== undefined) { bucket.geminiMsSum     += sample.geminiMs;     bucket.geminiMsN++; }
    switch (sample.outcome) {
      case 'ready':        bucket.ready++;       break;
      case 'retry':         bucket.retry++;        break;
      case 'invalid':       bucket.invalid++;      break;
      case 'low_evidence':  bucket.lowEvidence++;  break;
    }
  } catch (err) {
    logger.error({ err }, 'metricsCollector: recordSample failed');
  }
}

/**
 * Persist a bucket via idempotent UPSERT, then clear it from the live
 * accumulator so the same samples are never re-added on the next tick.
 * Guarded against concurrent overlapping flushes (timer tick + hour
 * rollover firing at the same time).
 */
export async function flush(explicitBucket?: BucketAccumulator): Promise<void> {
  const bucket = explicitBucket ?? current;
  if (!bucket || bucket.count === 0) return;

  // Only the current-bucket path needs the in-flight guard — an explicit
  // (already-detached) bucket from an hour rollover has nothing to race with.
  if (!explicitBucket) {
    if (flushInFlight) return;
    flushInFlight = true;
  }

  const questionsPerMin = bucket.count / 60;
  const avgValidationMs = bucket.validationMsN > 0 ? bucket.validationMsSum / bucket.validationMsN : null;
  const avgRetrievalMs  = bucket.retrievalMsN  > 0 ? bucket.retrievalMsSum  / bucket.retrievalMsN  : null;
  const avgGeminiMs     = bucket.geminiMsN     > 0 ? bucket.geminiMsSum     / bucket.geminiMsN     : null;
  const total = bucket.count;
  const successRate     = total > 0 ? bucket.ready / total : 0;
  const retryRate       = total > 0 ? bucket.retry / total : 0;
  const readyRate        = total > 0 ? bucket.ready / total : 0;
  const lowEvidenceRate  = total > 0 ? bucket.lowEvidence / total : 0;
  const invalidRate      = total > 0 ? bucket.invalid / total : 0;

  try {
    const pool = getSharedPool();
    await pool.query(
      `INSERT INTO public.validation_metrics_hourly
         (id, bucket_start, questions_per_min, avg_validation_ms, avg_retrieval_ms,
          avg_gemini_ms, success_rate, retry_rate, ready_rate, low_evidence_rate,
          invalid_rate, sample_count, updated_at)
       VALUES (gen_random_uuid(), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
       ON CONFLICT (bucket_start) DO UPDATE SET
         questions_per_min  = (public.validation_metrics_hourly.sample_count * public.validation_metrics_hourly.questions_per_min + EXCLUDED.sample_count * EXCLUDED.questions_per_min) / (public.validation_metrics_hourly.sample_count + EXCLUDED.sample_count),
         avg_validation_ms  = EXCLUDED.avg_validation_ms,
         avg_retrieval_ms   = EXCLUDED.avg_retrieval_ms,
         avg_gemini_ms      = EXCLUDED.avg_gemini_ms,
         success_rate       = EXCLUDED.success_rate,
         retry_rate         = EXCLUDED.retry_rate,
         ready_rate         = EXCLUDED.ready_rate,
         low_evidence_rate  = EXCLUDED.low_evidence_rate,
         invalid_rate       = EXCLUDED.invalid_rate,
         sample_count       = public.validation_metrics_hourly.sample_count + EXCLUDED.sample_count,
         updated_at         = now()`,
      [
        bucket.bucketStart, questionsPerMin, avgValidationMs, avgRetrievalMs,
        avgGeminiMs, successRate, retryRate, readyRate, lowEvidenceRate,
        invalidRate, total,
      ],
    );
    logger.debug({ bucketStart: bucket.bucketStart, total }, 'metricsCollector: flushed bucket');

    // Clear persisted samples from the live accumulator so the next flush
    // only reports NEW samples, not the same ones again.
    if (!explicitBucket && current === bucket) {
      current = emptyBucket(bucket.bucketStart);
    }
  } catch (err) {
    logger.error({ err }, 'metricsCollector: flush failed');
  } finally {
    if (!explicitBucket) flushInFlight = false;
  }
}

let flushTimer: ReturnType<typeof setInterval> | null = null;

/** Start a periodic flush timer (every 60s) so metrics are durable even
 *  mid-hour, without a DB write per question. Idempotent. */
export function startMetricsFlushTimer(): void {
  if (flushTimer !== null) return;
  flushTimer = setInterval(() => { void flush(); }, 60_000);
  logger.info('metricsCollector: periodic flush timer started');
}

export function stopMetricsFlushTimer(): void {
  if (flushTimer !== null) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
}
