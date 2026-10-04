import assert from 'node:assert/strict';
import test from 'node:test';
import {
  summarizeLivePreparationProgress,
} from './livePreparationProgress';

test('only READY questions count as complete and permanent failures stay incomplete', () => {
  const progress = summarizeLivePreparationProgress('exam-1', [
    { questionType: 'mcq', status: 'READY' },
    { questionType: 'mcq', status: 'INVALID' },
    { questionType: 'essay', status: 'PERMANENT_LOW_EVIDENCE' },
    { questionType: 'mcq', status: 'VALIDATED' },
  ]);

  assert.equal(progress.totalQuestions, 4);
  assert.equal(progress.readyQuestions, 1);
  assert.equal(progress.progressPct, 25);
  assert.equal(progress.remainingQuestions, 3);
  assert.equal(progress.terminalFailedQuestions, 2);
});

test('retry eligibility separates due work from future retry windows', () => {
  const now = new Date('2026-10-04T12:00:00.000Z');
  const progress = summarizeLivePreparationProgress('exam-2', [
    { questionType: 'mcq', status: 'PENDING' },
    { questionType: 'mcq', status: 'LOW_EVIDENCE', nextRetryAt: '2026-10-04T11:00:00.000Z' },
    { questionType: 'essay', status: 'LOW_EVIDENCE', nextRetryAt: '2026-10-04T13:00:00.000Z' },
    { questionType: 'essay', status: 'PERMANENT_LOW_EVIDENCE' },
  ], now);

  assert.equal(progress.retryableQuestions, 2);
  assert.equal(progress.waitingRetryQuestions, 1);
  assert.equal(progress.terminalFailedQuestions, 1);
  assert.equal(progress.nextEligibleAt, '2026-10-04T13:00:00.000Z');
});