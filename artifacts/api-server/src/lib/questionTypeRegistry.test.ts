/**
 * questionTypeRegistry.test.ts
 *
 * Consistency guard — runs via `pnpm test:registry`.
 * BUILD FAILS if any of these invariants are violated:
 *
 *   1. No duplicate type entries in the registry.
 *   2. Every deterministic type is a known type.
 *   3. Every option-required type is a known type.
 *   4. Every canonical-answer-required type is a known type.
 *   5. requiresPreparation=true implies requiresCanonicalAnswer=true.
 *   6. fill_in_blank is correctly classified (known, deterministic,
 *      requiresCanonicalAnswer, requiresPreparation, NOT requiresOptions).
 *   7. The derived sets match the registry entries that produced them.
 *
 * This test uses Node.js built-in test runner (no extra deps).
 */

import { test } from 'node:test';
import assert  from 'node:assert/strict';
import {
  QUESTION_TYPE_REGISTRY,
  KNOWN_TYPES,
  DETERMINISTIC_TYPES,
  OPTION_REQUIRED_TYPES,
  CANONICAL_ANSWER_REQUIRED_TYPES,
  PREPARATION_REQUIRED_TYPES,
  OPEN_PREPARATION_TYPES,
} from './questionTypeRegistry.js';

// ─── 1. No duplicates ─────────────────────────────────────────────────────────

test('registry: no duplicate type entries', () => {
  const seen = new Set<string>();
  for (const entry of QUESTION_TYPE_REGISTRY) {
    assert.ok(
      !seen.has(entry.type),
      `Duplicate type in registry: "${entry.type}"`,
    );
    seen.add(entry.type);
  }
});

// ─── 2. Every deterministic type is known ─────────────────────────────────────

test('registry: every deterministic type is a known type', () => {
  for (const type of DETERMINISTIC_TYPES) {
    assert.ok(
      KNOWN_TYPES.has(type),
      `Deterministic type "${type}" is not in KNOWN_TYPES — add it to the registry`,
    );
  }
});

// ─── 3. Every option-required type is known ───────────────────────────────────

test('registry: every option-required type is a known type', () => {
  for (const type of OPTION_REQUIRED_TYPES) {
    assert.ok(
      KNOWN_TYPES.has(type),
      `Option-required type "${type}" is not in KNOWN_TYPES — add it to the registry`,
    );
  }
});

// ─── 4. Every canonical-answer-required type is known ─────────────────────────

test('registry: every canonical-answer-required type is a known type', () => {
  for (const type of CANONICAL_ANSWER_REQUIRED_TYPES) {
    assert.ok(
      KNOWN_TYPES.has(type),
      `Canonical-answer-required type "${type}" is not in KNOWN_TYPES — add it to the registry`,
    );
  }
});

// ─── 5. requiresPreparation implies (requiresCanonicalAnswer OR requiresOpenPreparation) ──

test('registry: requiresPreparation=true implies requiresCanonicalAnswer=true OR requiresOpenPreparation=true', () => {
  for (const entry of QUESTION_TYPE_REGISTRY) {
    if (entry.requiresPreparation) {
      assert.ok(
        entry.requiresCanonicalAnswer || entry.requiresOpenPreparation,
        `"${entry.type}" has requiresPreparation=true but neither requiresCanonicalAnswer nor requiresOpenPreparation is true — at least one preparation store must be specified`,
      );
    }
  }
});

test('registry: requiresOpenPreparation=true implies requiresCanonicalAnswer=false', () => {
  for (const entry of QUESTION_TYPE_REGISTRY) {
    if (entry.requiresOpenPreparation) {
      assert.ok(
        !entry.requiresCanonicalAnswer,
        `"${entry.type}" has both requiresOpenPreparation=true and requiresCanonicalAnswer=true — a type can only use one preparation store`,
      );
    }
  }
});

// ─── 6. fill_in_blank is correctly classified ─────────────────────────────────

test('registry: fill_in_blank is known', () => {
  assert.ok(KNOWN_TYPES.has('fill_in_blank'), 'fill_in_blank must be in KNOWN_TYPES');
});

test('registry: fill_in_blank uses deterministic grading', () => {
  assert.ok(DETERMINISTIC_TYPES.has('fill_in_blank'), 'fill_in_blank must be in DETERMINISTIC_TYPES');
});

test('registry: fill_in_blank requires a canonical answer', () => {
  assert.ok(
    CANONICAL_ANSWER_REQUIRED_TYPES.has('fill_in_blank'),
    'fill_in_blank must be in CANONICAL_ANSWER_REQUIRED_TYPES',
  );
});

test('registry: fill_in_blank requires preparation', () => {
  assert.ok(
    PREPARATION_REQUIRED_TYPES.has('fill_in_blank'),
    'fill_in_blank must be in PREPARATION_REQUIRED_TYPES',
  );
});

test('registry: fill_in_blank does NOT require an options array', () => {
  assert.ok(
    !OPTION_REQUIRED_TYPES.has('fill_in_blank'),
    'fill_in_blank must NOT be in OPTION_REQUIRED_TYPES (it is a free-text answer)',
  );
});

// ─── 7. Derived sets match registry entries ───────────────────────────────────

test('registry: KNOWN_TYPES matches registry known=true entries', () => {
  const expected = new Set(
    QUESTION_TYPE_REGISTRY.filter((t) => t.known).map((t) => t.type),
  );
  assert.deepEqual(KNOWN_TYPES, expected);
});

test('registry: DETERMINISTIC_TYPES matches registry gradingStrategy=deterministic entries', () => {
  const expected = new Set(
    QUESTION_TYPE_REGISTRY
      .filter((t) => t.gradingStrategy === 'deterministic')
      .map((t) => t.type),
  );
  assert.deepEqual(DETERMINISTIC_TYPES, expected);
});

test('registry: OPTION_REQUIRED_TYPES matches registry requiresOptions=true entries', () => {
  const expected = new Set(
    QUESTION_TYPE_REGISTRY.filter((t) => t.requiresOptions).map((t) => t.type),
  );
  assert.deepEqual(OPTION_REQUIRED_TYPES, expected);
});

test('registry: CANONICAL_ANSWER_REQUIRED_TYPES matches registry requiresCanonicalAnswer=true entries', () => {
  const expected = new Set(
    QUESTION_TYPE_REGISTRY
      .filter((t) => t.requiresCanonicalAnswer)
      .map((t) => t.type),
  );
  assert.deepEqual(CANONICAL_ANSWER_REQUIRED_TYPES, expected);
});

test('registry: PREPARATION_REQUIRED_TYPES matches registry requiresPreparation=true entries', () => {
  const expected = new Set(
    QUESTION_TYPE_REGISTRY
      .filter((t) => t.requiresPreparation)
      .map((t) => t.type),
  );
  assert.deepEqual(PREPARATION_REQUIRED_TYPES, expected);
});

test('registry: OPEN_PREPARATION_TYPES matches registry requiresOpenPreparation=true entries', () => {
  const expected = new Set(
    QUESTION_TYPE_REGISTRY
      .filter((t) => t.requiresOpenPreparation)
      .map((t) => t.type),
  );
  assert.deepEqual(OPEN_PREPARATION_TYPES, expected);
});

// ─── 8. Open-prepared types are correctly classified ──────────────────────────

test('registry: short_answer is in OPEN_PREPARATION_TYPES and PREPARATION_REQUIRED_TYPES', () => {
  assert.ok(OPEN_PREPARATION_TYPES.has('short_answer'));
  assert.ok(PREPARATION_REQUIRED_TYPES.has('short_answer'));
});

test('registry: calculation is in OPEN_PREPARATION_TYPES and PREPARATION_REQUIRED_TYPES', () => {
  assert.ok(OPEN_PREPARATION_TYPES.has('calculation'));
  assert.ok(PREPARATION_REQUIRED_TYPES.has('calculation'));
});

test('registry: essay is in OPEN_PREPARATION_TYPES and PREPARATION_REQUIRED_TYPES', () => {
  assert.ok(OPEN_PREPARATION_TYPES.has('essay'));
  assert.ok(PREPARATION_REQUIRED_TYPES.has('essay'));
});

test('registry: open-prepared types are NOT in CANONICAL_ANSWER_REQUIRED_TYPES', () => {
  for (const type of OPEN_PREPARATION_TYPES) {
    assert.ok(
      !CANONICAL_ANSWER_REQUIRED_TYPES.has(type),
      `Open-prepared type "${type}" must not be in CANONICAL_ANSWER_REQUIRED_TYPES`,
    );
  }
});

test('registry: MCQ/TF/fill_in_blank are NOT in OPEN_PREPARATION_TYPES', () => {
  for (const type of ['mcq', 'true_false', 'fill_in_blank']) {
    assert.ok(
      !OPEN_PREPARATION_TYPES.has(type),
      `"${type}" must not be in OPEN_PREPARATION_TYPES — it uses exam_canonical_answers`,
    );
  }
});

// ─── 9. Existing types not removed (regression guard) ─────────────────────────

test('registry: all pre-existing types are still present', () => {
  const required = ['mcq', 'true_false', 'fill_in_blank', 'short_answer', 'essay', 'calculation'];
  for (const type of required) {
    assert.ok(
      KNOWN_TYPES.has(type),
      `Pre-existing type "${type}" is missing from KNOWN_TYPES — do not remove types`,
    );
  }
});
