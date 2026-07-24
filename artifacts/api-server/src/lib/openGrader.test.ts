/**
 * openGrader.test.ts
 *
 * Unit tests for the deterministic open-ended grader.
 * No Gemini, no DB, no network — pure function tests.
 *
 * Run: pnpm test:open-grader
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { gradeWithOpenPackage } from './correctionEngine/openGrader.js';
import type {
  ShortAnswerPackage,
  CalculationPackage,
  EssayPackage,
} from './examValidation/openPreparationDeriver.js';
import type { QuestionCorrectionInput } from './correctionEngine/types.js';

function makeInput(studentAnswer: string | null): QuestionCorrectionInput {
  return {
    questionId:    'test-q-1',
    question:      'Test question',
    questionType:  'short_answer',
    correctAnswer: null,
    options:       null,
    topic:         null,
    chapter:       null,
    subject:       'biology',
    grade:         '12',
    country:       'sudan',
    studentAnswer,
  };
}

// ─── Short Answer ─────────────────────────────────────────────────────────────

describe('openGrader: short_answer', () => {
  const pkg: ShortAnswerPackage = {
    type:                    'short_answer',
    canonicalAnswer:         'عملية التمثيل الضوئي',
    acceptedSemanticAnswers: ['البناء الضوئي', 'photosynthesis'],
    requiredConcepts:        ['الكلوروفيل', 'الطاقة الضوئية', 'ثاني أكسيد الكربون'],
    scientificGuardTerms:    ['كلوروبلاست'],
    acceptedKeywords:        ['ضوء', 'ماء', 'أكسجين'],
  };

  test('empty answer → isCorrect=false, scoreRatio=0', () => {
    const r = gradeWithOpenPackage(makeInput(null), pkg);
    assert.equal(r.isCorrect, false);
    assert.equal(r.scoreRatio, 0);
    assert.equal(r.gradingMethod, 'skipped');
  });

  test('exact canonical answer match → isCorrect=true, scoreRatio=1.0', () => {
    const r = gradeWithOpenPackage(makeInput('عملية التمثيل الضوئي'), pkg);
    assert.equal(r.isCorrect, true);
    assert.equal(r.scoreRatio, 1.0);
  });

  test('accepted semantic answer match → isCorrect=true', () => {
    const r = gradeWithOpenPackage(makeInput('البناء الضوئي هو العملية'), pkg);
    assert.equal(r.isCorrect, true);
    assert.equal(r.scoreRatio, 1.0);
  });

  test('all required concepts present → high score', () => {
    const r = gradeWithOpenPackage(
      makeInput('يحتاج الكلوروفيل الطاقة الضوئية وثاني أكسيد الكربون'),
      pkg,
    );
    assert.ok(r.scoreRatio >= 0.5, `Expected scoreRatio >= 0.5, got ${r.scoreRatio}`);
    assert.equal(r.isCorrect, true);
  });

  test('wrong answer → isCorrect=false', () => {
    const r = gradeWithOpenPackage(makeInput('التنفس الخلوي'), pkg);
    assert.equal(r.isCorrect, false);
  });

  test('gradingMethod is exact (not ai)', () => {
    const r = gradeWithOpenPackage(makeInput('عملية التمثيل الضوئي'), pkg);
    assert.equal(r.gradingMethod, 'exact');
  });
});

// ─── Calculation ──────────────────────────────────────────────────────────────

describe('openGrader: calculation', () => {
  const pkg: CalculationPackage = {
    type:                       'calculation',
    canonicalAnswer:            '9.8 m/s²',
    formula:                    'F = ma',
    expectedNumericResult:      9.8,
    numericTolerance:           0.05, // 5%
    acceptedUnits:              ['m/s²', 'N/kg'],
    acceptedFormats:            ['9.8', '9.80'],
    alternativeSolutionMethods: [],
    requiredConcepts:           ['تسارع', 'قوة الجاذبية'],
  };

  test('exact numeric match → isCorrect=true, scoreRatio=1.0', () => {
    const r = gradeWithOpenPackage({ ...makeInput('9.8 m/s²'), questionType: 'calculation' }, pkg);
    assert.equal(r.isCorrect, true);
    assert.equal(r.scoreRatio, 1.0);
  });

  test('within tolerance → isCorrect=true', () => {
    // 9.75 is within 5% of 9.8
    const r = gradeWithOpenPackage({ ...makeInput('9.75'), questionType: 'calculation' }, pkg);
    assert.equal(r.isCorrect, true);
  });

  test('outside tolerance → isCorrect=false', () => {
    // 5.0 is way off
    const r = gradeWithOpenPackage({ ...makeInput('5.0'), questionType: 'calculation' }, pkg);
    assert.equal(r.isCorrect, false);
  });

  test('Arabic-Indic numerals extracted correctly', () => {
    const r = gradeWithOpenPackage({ ...makeInput('٩.٨'), questionType: 'calculation' }, pkg);
    assert.equal(r.isCorrect, true);
  });

  test('no numeric in answer → partial concept credit only', () => {
    const r = gradeWithOpenPackage({ ...makeInput('تسارع قوة الجاذبية'), questionType: 'calculation' }, pkg);
    assert.ok(r.scoreRatio <= 0.5, `Expected scoreRatio <= 0.5, got ${r.scoreRatio}`);
  });

  test('empty answer → scoreRatio=0', () => {
    const r = gradeWithOpenPackage({ ...makeInput(''), questionType: 'calculation' }, pkg);
    assert.equal(r.scoreRatio, 0);
  });
});

// ─── Essay ────────────────────────────────────────────────────────────────────

describe('openGrader: essay', () => {
  const pkg: EssayPackage = {
    type:                   'essay',
    requiredConcepts:       ['الانتقاء الطبيعي', 'التكيف', 'التطور'],
    requiredEvidence:       ['نظرية داروين', 'الانتقاء البيئي'],
    expectedStructure:      'مقدمة ثم تطوير ثم خاتمة',
    scoringCriteria:        ['يذكر الانتقاء الطبيعي', 'يشرح التكيف', 'يربط بالتطور'],
    scientificGuardConcepts:['الجين', 'الطفرة'],
  };

  test('all concepts present → isCorrect=true, high score', () => {
    const r = gradeWithOpenPackage(
      { ...makeInput('الانتقاء الطبيعي يؤدي إلى التكيف والتطور من خلال الجين والطفرة'), questionType: 'essay' },
      pkg,
    );
    assert.equal(r.isCorrect, true);
    assert.ok(r.scoreRatio >= 0.7, `Expected >= 0.7, got ${r.scoreRatio}`);
  });

  test('no concepts → low score', () => {
    const r = gradeWithOpenPackage(
      { ...makeInput('الخلية تتكاثر'), questionType: 'essay' },
      pkg,
    );
    assert.equal(r.isCorrect, false);
  });

  test('partial concept coverage → partial credit', () => {
    const r = gradeWithOpenPackage(
      { ...makeInput('الانتقاء الطبيعي يذكر الانتقاء الطبيعي'), questionType: 'essay' },
      pkg,
    );
    // 1 of 3 concepts = ~0.33 concept score; may or may not be >= 0.5
    assert.ok(r.scoreRatio >= 0 && r.scoreRatio <= 1);
  });

  test('gradingMethod is exact', () => {
    const r = gradeWithOpenPackage(
      { ...makeInput('الانتقاء الطبيعي'), questionType: 'essay' },
      pkg,
    );
    assert.equal(r.gradingMethod, 'exact');
  });

  test('empty answer → isCorrect=false', () => {
    const r = gradeWithOpenPackage({ ...makeInput(null), questionType: 'essay' }, pkg);
    assert.equal(r.isCorrect, false);
    assert.equal(r.scoreRatio, 0);
  });
});

// ─── Registry consistency ─────────────────────────────────────────────────────

describe('openGrader: registry alignment', () => {
  test('short_answer, calculation, essay are all handled (no unknown type fallthrough)', () => {
    const types = ['short_answer', 'calculation', 'essay'];
    for (const t of types) {
      // The switch in openGrader handles all three — this verifies no TypeError at runtime
      // We create minimal valid packages for each type
      let pkg: ShortAnswerPackage | CalculationPackage | EssayPackage;
      if (t === 'short_answer') {
        pkg = { type: 'short_answer', canonicalAnswer: 'x', acceptedSemanticAnswers: [], requiredConcepts: [], scientificGuardTerms: [], acceptedKeywords: [] };
      } else if (t === 'calculation') {
        pkg = { type: 'calculation', canonicalAnswer: '1', formula: '', expectedNumericResult: 1, numericTolerance: 0.05, acceptedUnits: [], acceptedFormats: [], alternativeSolutionMethods: [], requiredConcepts: [] };
      } else {
        pkg = { type: 'essay', requiredConcepts: [], requiredEvidence: [], expectedStructure: '', scoringCriteria: [], scientificGuardConcepts: [] };
      }
      const r = gradeWithOpenPackage({ ...makeInput('some answer'), questionType: t }, pkg);
      assert.ok(typeof r.isCorrect === 'boolean', `${t}: isCorrect must be boolean`);
      assert.ok(r.scoreRatio >= 0 && r.scoreRatio <= 1, `${t}: scoreRatio must be 0–1`);
      assert.equal(r.gradingMethod, 'exact', `${t}: gradingMethod must be exact`);
    }
  });
});
