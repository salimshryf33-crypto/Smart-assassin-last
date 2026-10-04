import assert from 'node:assert/strict';
import test from 'node:test';
import { isRetryableInferenceFailure, shouldGiveUp } from './retryPolicy';

test('retry policy accepts transient provider, network, and response failures', () => {
  assert.equal(isRetryableInferenceFailure({ status: 429, message: 'rate limited' }), true);
  assert.equal(isRetryableInferenceFailure({ statusCode: 503, message: 'unavailable' }), true);
  assert.equal(
    isRetryableInferenceFailure(new TypeError('fetch failed', {
      cause: Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }),
    })),
    true,
  );
  assert.equal(isRetryableInferenceFailure(new SyntaxError('invalid JSON')), true);
});

test('retry policy rejects permanent client/configuration errors and bounds retries', () => {
  assert.equal(isRetryableInferenceFailure({ status: 400, message: 'bad request' }), false);
  assert.equal(isRetryableInferenceFailure({ status: 401, message: 'unauthorized' }), false);
  assert.equal(isRetryableInferenceFailure(new Error('missing Gemini API configuration')), false);
  assert.equal(shouldGiveUp(3), false);
  assert.equal(shouldGiveUp(4), true);
});