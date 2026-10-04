import assert from 'node:assert/strict';
import test from 'node:test';
import { comparePreparationQueueCandidates } from './preparationQueue';

test('queue order keeps running jobs first, then priority, live progress, and age', () => {
  const candidates = [
    { status: 'pending', priority: 1, progressPct: 99, createdAt: '2026-01-01T00:00:00Z' },
    { status: 'paused', priority: 1, progressPct: 50, createdAt: '2025-01-01T00:00:00Z' },
    { status: 'running', priority: 5, progressPct: 2, createdAt: '2026-01-01T00:00:00Z' },
    { status: 'pending', priority: 2, progressPct: 99, createdAt: '2024-01-01T00:00:00Z' },
    { status: 'pending', priority: 1, progressPct: 50, createdAt: '2024-01-01T00:00:00Z' },
  ];

  const ordered = [...candidates].sort(comparePreparationQueueCandidates);
  assert.deepEqual(ordered, [
    candidates[2],
    candidates[0],
    candidates[4],
    candidates[1],
    candidates[3],
  ]);
});