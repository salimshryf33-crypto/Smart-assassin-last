/**
 * quizEngine.test.ts — Unit tests for QUIZ_MODE pure functions.
 *
 * Run with:
 *   pnpm --filter @workspace/smart-study test:quiz
 *
 * Tests (14 total):
 *   Group A — countryLabel()    : 3 tests
 *   Group B — levelLabel()      : 4 tests
 *   Group C — buildQuizPrompt() : 6 tests
 *   Group D — NO_QUIZ_CONTENT_RESPONSE : 1 test
 *
 * Design: pure unit tests — no mocks, no network, no DOM.
 * Stops immediately on first failure (node:test default behaviour).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  countryLabel,
  levelLabel,
  buildQuizPrompt,
  NO_QUIZ_CONTENT_RESPONSE,
  type QuizPromptParams,
} from './quizEngine.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const BASE_PARAMS: QuizPromptParams = {
  country:    'egypt',
  level:      'secondary',
  subject:    'الفيزياء',
  track:      'علمي',
  ragContext: 'الكثافة = الكتلة ÷ الحجم. وحدة الكثافة هي كغ/م³.',
};

// ─── Group A: countryLabel ────────────────────────────────────────────────────

describe('countryLabel', () => {
  it('maps egypt → مصر', () => {
    assert.equal(countryLabel('egypt'), 'مصر');
  });

  it('maps sudan → السودان', () => {
    assert.equal(countryLabel('sudan'), 'السودان');
  });

  it('returns unknown country as-is', () => {
    assert.equal(countryLabel('morocco'), 'morocco');
  });
});

// ─── Group B: levelLabel ──────────────────────────────────────────────────────

describe('levelLabel', () => {
  it('maps primary → المرحلة الابتدائية', () => {
    assert.equal(levelLabel('primary'), 'المرحلة الابتدائية');
  });

  it('maps preparatory → المرحلة الإعدادية', () => {
    assert.equal(levelLabel('preparatory'), 'المرحلة الإعدادية');
  });

  it('maps secondary → المرحلة الثانوية', () => {
    assert.equal(levelLabel('secondary'), 'المرحلة الثانوية');
  });

  it('returns unknown level as-is', () => {
    assert.equal(levelLabel('university'), 'university');
  });
});

// ─── Group C: buildQuizPrompt ─────────────────────────────────────────────────

describe('buildQuizPrompt', () => {
  it('returns a non-empty string', () => {
    const result = buildQuizPrompt(BASE_PARAMS);
    assert.ok(typeof result === 'string' && result.length > 0, 'Expected non-empty string');
  });

  it('contains the translated country label', () => {
    const result = buildQuizPrompt(BASE_PARAMS);
    assert.ok(result.includes('مصر'), 'Expected country label "مصر" in prompt');
  });

  it('contains the translated level label', () => {
    const result = buildQuizPrompt(BASE_PARAMS);
    assert.ok(result.includes('المرحلة الثانوية'), 'Expected level label in prompt');
  });

  it('embeds the subject name', () => {
    const result = buildQuizPrompt(BASE_PARAMS);
    assert.ok(result.includes('الفيزياء'), 'Expected subject "الفيزياء" in prompt');
  });

  it('embeds the ragContext verbatim', () => {
    const result = buildQuizPrompt(BASE_PARAMS);
    assert.ok(
      result.includes(BASE_PARAMS.ragContext),
      'Expected ragContext to appear verbatim in prompt'
    );
  });

  it('contains the rule forbidding answer reveal before student replies', () => {
    const result = buildQuizPrompt(BASE_PARAMS);
    assert.ok(
      result.includes('لا تكشف الإجابة الصحيحة'),
      'Expected rule "لا تكشف الإجابة الصحيحة" in prompt'
    );
  });
});

// ─── Group D: NO_QUIZ_CONTENT_RESPONSE ───────────────────────────────────────

describe('NO_QUIZ_CONTENT_RESPONSE', () => {
  it('is a non-empty Arabic string', () => {
    assert.ok(
      typeof NO_QUIZ_CONTENT_RESPONSE === 'string' && NO_QUIZ_CONTENT_RESPONSE.length > 0,
      'Expected non-empty string'
    );
  });
});
