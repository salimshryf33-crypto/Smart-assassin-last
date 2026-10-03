import assert from 'node:assert/strict';
import test from 'node:test';
import { disambiguateExamTitles } from './examDisplay';

test('duplicate exam titles use distinct ID suffixes even with identical dates', () => {
  const titles = disambiguateExamTitles([
    { examId: 'exam-abc123', title: 'Biology 2022', createdAt: '2025-01-01T00:00:00Z' },
    { examId: 'exam-xyz123', title: 'Biology 2022', createdAt: '2025-01-01T00:00:00Z' },
  ]);

  assert.equal(titles.get('exam-abc123'), 'Biology 2022 · abc123');
  assert.equal(titles.get('exam-xyz123'), 'Biology 2022 · xyz123');
});

test('repeated dashboard rows for one exam do not make its title look duplicated', () => {
  const titles = disambiguateExamTitles([
    { examId: 'exam-abc123', title: 'Biology 2022' },
    { examId: 'exam-abc123', title: 'Biology 2022' },
  ]);

  assert.equal(titles.get('exam-abc123'), 'Biology 2022');
});

test('colliding six-character suffixes are extended until unique', () => {
  const titles = disambiguateExamTitles([
    { examId: 'prefixA123456', title: 'Chemistry 2022' },
    { examId: 'prefixB123456', title: 'Chemistry 2022' },
  ]);

  assert.equal(titles.get('prefixA123456'), 'Chemistry 2022 · A123456');
  assert.equal(titles.get('prefixB123456'), 'Chemistry 2022 · B123456');
});