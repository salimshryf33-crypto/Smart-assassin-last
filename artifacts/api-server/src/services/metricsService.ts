/**
 * metricsService.ts — Lightweight production metrics for Sage.
 *
 * Tracks:
 *  - Gemini AI calls (success / failure / quota errors / avg latency)
 *  - Search requests (top subjects, top grades, avg latency)
 *  - Request counters (total, active, errors)
 *
 * Design rules:
 *  - Pure in-memory singleton. Never throws. Never blocks other logic.
 *  - Persists snapshot to /tmp/sage-metrics.json every 5 min so metrics
 *    survive server restarts (best-effort, silently ignored on failure).
 *  - Rolling avg latency uses a capped 500-sample window (no memory leak).
 */

import fs from 'node:fs';

const PERSIST_PATH = '/tmp/sage-metrics.json';
const PERSIST_INTERVAL_MS = 5 * 60 * 1000;
const MAX_SAMPLES = 500;

// ─── Internal state ───────────────────────────────────────────────────────────

interface State {
  gemini: {
    callsToday:   number;
    callsTotal:   number;
    failures:     number;
    quotaErrors:  number;
    _latencies:   number[];
    _resetDate:   string;
  };
  search: {
    total:       number;
    _latencies:  number[];
    subjects:    Record<string, number>;
    grades:      Record<string, number>;
  };
  requests: {
    total:        number;
    errors:       number;
    active:       number;
  };
  startedAt: string;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function makeDefault(): State {
  return {
    gemini: {
      callsToday:  0,
      callsTotal:  0,
      failures:    0,
      quotaErrors: 0,
      _latencies:  [],
      _resetDate:  today(),
    },
    search: {
      total:      0,
      _latencies: [],
      subjects:   {},
      grades:     {},
    },
    requests: {
      total:  0,
      errors: 0,
      active: 0,
    },
    startedAt: new Date().toISOString(),
  };
}

let state: State = makeDefault();

// ─── Persistence ──────────────────────────────────────────────────────────────

function loadFromDisk(): void {
  try {
    const raw = fs.readFileSync(PERSIST_PATH, 'utf8');
    const saved = JSON.parse(raw) as Partial<State>;
    // Merge carefully — never overwrite with corrupt data
    if (saved.gemini)   state.gemini   = { ...state.gemini,   ...saved.gemini };
    if (saved.search)   state.search   = { ...state.search,   ...saved.search };
    if (saved.requests) state.requests = { ...state.requests, ...saved.requests, active: 0 };
    if (saved.startedAt) state.startedAt = saved.startedAt;
    // Reset "active" to 0 on restart
    state.requests.active = 0;
    // Reset today counter if date changed
    if (state.gemini._resetDate !== today()) {
      state.gemini.callsToday = 0;
      state.gemini._resetDate = today();
    }
  } catch {
    // File missing or corrupt — use defaults
  }
}

function saveToDisk(): void {
  try {
    const toSave = {
      gemini:   { ...state.gemini,   _latencies: [] },
      search:   { ...state.search,   _latencies: [] },
      requests: { ...state.requests, active: 0 },
      startedAt: state.startedAt,
    };
    fs.writeFileSync(PERSIST_PATH, JSON.stringify(toSave));
  } catch {
    // Non-fatal — metrics are best-effort
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────

loadFromDisk();
setInterval(saveToDisk, PERSIST_INTERVAL_MS).unref();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function pushSample(arr: number[], value: number): void {
  arr.push(value);
  if (arr.length > MAX_SAMPLES) arr.shift();
}

function avgOf(arr: number[]): number {
  if (arr.length === 0) return 0;
  return Math.round(arr.reduce((s, n) => s + n, 0) / arr.length);
}

function topN(map: Record<string, number>, n = 5): Array<{ name: string; count: number }> {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([name, count]) => ({ name, count }));
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Called by metricsMiddleware on every request start. */
export function requestStarted(): void {
  state.requests.active++;
  state.requests.total++;
}

/** Called by metricsMiddleware on response finish. */
export function requestFinished(statusCode: number): void {
  state.requests.active = Math.max(0, state.requests.active - 1);
  if (statusCode >= 500) state.requests.errors++;
}

/** Record a Gemini API call result. */
export function recordGeminiCall(opts: {
  success:    boolean;
  latencyMs:  number;
  quotaError: boolean;
}): void {
  // Reset daily counter if date rolled over
  if (state.gemini._resetDate !== today()) {
    state.gemini.callsToday = 0;
    state.gemini._resetDate = today();
  }
  state.gemini.callsTotal++;
  state.gemini.callsToday++;
  if (!opts.success)     state.gemini.failures++;
  if (opts.quotaError)   state.gemini.quotaErrors++;
  if (opts.latencyMs > 0) pushSample(state.gemini._latencies, opts.latencyMs);
}

/** Record a curriculum search request. */
export function recordSearch(opts: {
  subject:   string;
  grade:     string;
  latencyMs: number;
}): void {
  state.search.total++;
  pushSample(state.search._latencies, opts.latencyMs);
  state.search.subjects[opts.subject] = (state.search.subjects[opts.subject] ?? 0) + 1;
  state.search.grades[opts.grade]     = (state.search.grades[opts.grade]     ?? 0) + 1;
}

/** Return a plain-JSON snapshot of all metrics. */
export function getSnapshot() {
  return {
    generatedAt: new Date().toISOString(),
    uptime: {
      startedAt:     state.startedAt,
      uptimeSeconds: Math.floor(process.uptime()),
    },
    requests: {
      total:         state.requests.total,
      active:        state.requests.active,
      errors:        state.requests.errors,
    },
    gemini: {
      callsToday:    state.gemini.callsToday,
      callsTotal:    state.gemini.callsTotal,
      failures:      state.gemini.failures,
      quotaErrors:   state.gemini.quotaErrors,
      avgResponseMs: avgOf(state.gemini._latencies),
      successRate:   state.gemini.callsTotal === 0
        ? 100
        : Math.round(((state.gemini.callsTotal - state.gemini.failures) / state.gemini.callsTotal) * 100),
    },
    search: {
      total:         state.search.total,
      avgLatencyMs:  avgOf(state.search._latencies),
      topSubjects:   topN(state.search.subjects),
      topGrades:     topN(state.search.grades),
    },
  };
}
