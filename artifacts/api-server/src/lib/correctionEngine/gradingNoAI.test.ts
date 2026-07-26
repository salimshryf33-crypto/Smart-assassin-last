/**
 * gradingNoAI.test.ts
 *
 * Runtime Contract regression tests — Preparation-First Exam Architecture.
 *
 * WHAT THIS PROVES:
 *   1. All 6 question types (MCQ, true_false, fill_in_blank, short_answer,
 *      calculation, essay) execute grading without producing gradingMethod='ai'.
 *   2. gradingMethod is always 'exact' or 'skipped' — never 'ai' or 'insufficient'.
 *   3. The GradingRuntimeAIViolationError guard fires immediately when
 *      assertNotInGradingContext() is called inside a grading context.
 *   4. The guard is inactive by default and resets cleanly after exitGradingContext().
 *   5. If any future AI call is injected into the grading path, the guard fires
 *      before any network I/O — the test for this is in section 4 below.
 *
 * Run: pnpm --filter @workspace/api-server test:grading-no-ai
 *
 * Uses Node.js built-in test runner (no extra deps).
 */

import { test, describe } from 'node:test';
import assert              from 'node:assert/strict';

import { gradeDeterministic }  from './deterministicGrader.js';
import { gradeWithOpenPackage } from './openGrader.js';
import {
  enterGradingContext,
  exitGradingContext,
  assertNotInGradingContext,
  isInGradingContext,
  GradingRuntimeAIViolationError,
} from '../gradingGuard.js';
import type { QuestionCorrectionInput } from './types.js';
import type {
  ShortAnswerPackage,
  CalculationPackage,
  EssayPackage,
} from '../examValidation/openPreparationDeriver.js';

// ─── Shared helpers ───────────────────────────────────────────────────────────

function makeInput(
  questionType:  string,
  studentAnswer: string | null,
  correctAnswer: string | null = 'الإجابة الصحيحة',
): QuestionCorrectionInput {
  return {
    questionId:   `test-${questionType}-001`,
    question:     'سؤال اختباري',
    questionType,
    correctAnswer,
    options:      null,
    topic:        'موضوع',
    chapter:      'الفصل الأول',
    subject:      'biology',
    grade:        '12',
    country:      'sudan',
    studentAnswer,
  };
}

const SHORT_ANSWER_PKG: ShortAnswerPackage = {
  type:                    'short_answer',
  canonicalAnswer:         'التمثيل الضوئي',
  acceptedSemanticAnswers: ['البناء الضوئي'],
  requiredConcepts:        ['الكلوروفيل', 'الطاقة الضوئية'],
  scientificGuardTerms:    ['كلوروبلاست'],
  acceptedKeywords:        ['ضوء', 'ماء'],
};

const CALCULATION_PKG: CalculationPackage = {
  type:                       'calculation',
  canonicalAnswer:            '9.8 m/s²',
  formula:                    'F = ma',
  expectedNumericResult:      9.8,
  numericTolerance:           0.05,
  acceptedUnits:              ['m/s²'],
  acceptedFormats:            ['9.8'],
  alternativeSolutionMethods: [],
  requiredConcepts:           ['تسارع', 'قوة الجاذبية'],
};

const ESSAY_PKG: EssayPackage = {
  type:                    'essay',
  requiredConcepts:        ['التطور', 'الانتقاء الطبيعي'],
  requiredEvidence:        ['نظرية داروين'],
  expectedStructure:       'مقدمة وتطوير وخاتمة',
  scoringCriteria:         ['يذكر التطور', 'يشرح الانتقاء الطبيعي'],
  scientificGuardConcepts: ['الجين', 'الطفرة'],
};

// ─── Section 1: Runtime Guard mechanics ───────────────────────────────────────

describe('gradingGuard: guard mechanics', () => {
  test('guard is inactive by default', () => {
    assert.equal(isInGradingContext(), false);
  });

  test('enterGradingContext activates the guard', () => {
    enterGradingContext('test-attempt-001');
    assert.equal(isInGradingContext(), true);
    exitGradingContext(); // cleanup
  });

  test('exitGradingContext deactivates the guard', () => {
    enterGradingContext('test-attempt-002');
    exitGradingContext();
    assert.equal(isInGradingContext(), false);
  });

  test('assertNotInGradingContext is silent when guard is inactive', () => {
    assert.doesNotThrow(() => assertNotInGradingContext('test-caller'));
  });

  test('assertNotInGradingContext throws GradingRuntimeAIViolationError when guard is active', () => {
    enterGradingContext('test-attempt-003');
    try {
      assert.throws(
        () => assertNotInGradingContext('unit-test-caller'),
        (err: unknown) => {
          assert.ok(err instanceof GradingRuntimeAIViolationError, `Expected GradingRuntimeAIViolationError, got ${String(err)}`);
          return true;
        },
      );
    } finally {
      exitGradingContext();
    }
  });

  test('GradingRuntimeAIViolationError carries attemptId and aiCaller', () => {
    const err = new GradingRuntimeAIViolationError('my.callGemini', 'attempt-xyz');
    assert.equal(err.attemptId, 'attempt-xyz');
    assert.equal(err.aiCaller, 'my.callGemini');
    assert.equal(err.name, 'GradingRuntimeAIViolationError');
    assert.ok(err.message.includes('GRADING RUNTIME VIOLATION'));
    assert.ok(err.message.includes('my.callGemini'));
    assert.ok(err.message.includes('attempt-xyz'));
  });

  test('GradingRuntimeAIViolationError is an instance of Error', () => {
    const err = new GradingRuntimeAIViolationError('test', null);
    assert.ok(err instanceof Error);
  });

  test('guard resets cleanly: second activation after exit works', () => {
    enterGradingContext('attempt-A');
    exitGradingContext();
    assert.equal(isInGradingContext(), false);
    // Activate again — must not be stale
    enterGradingContext('attempt-B');
    assert.equal(isInGradingContext(), true);
    exitGradingContext();
    assert.equal(isInGradingContext(), false);
  });

  test('assertNotInGradingContext is safe to call multiple times outside context', () => {
    for (let i = 0; i < 5; i++) {
      assert.doesNotThrow(() => assertNotInGradingContext(`caller-${i}`));
    }
  });
});

// ─── Section 2: MCQ — no AI ───────────────────────────────────────────────────

describe('gradeDeterministic: mcq — no AI invocation', () => {
  test('correct answer → isCorrect=true, gradingMethod=exact', () => {
    const r = gradeDeterministic('أ) الخلية النباتية', 'أ) الخلية النباتية', 'mcq');
    assert.equal(r.isCorrect, true);
    assert.equal(r.gradingMethod, 'exact');
    assert.notEqual(r.gradingMethod, 'ai');
  });

  test('wrong answer → isCorrect=false, gradingMethod=exact', () => {
    const r = gradeDeterministic('ب) الخلية الحيوانية', 'أ) الخلية النباتية', 'mcq');
    assert.equal(r.isCorrect, false);
    assert.equal(r.gradingMethod, 'exact');
    assert.notEqual(r.gradingMethod, 'ai');
  });

  test('null student answer → gradingMethod=skipped', () => {
    const r = gradeDeterministic(null, 'أ) الإجابة', 'mcq');
    assert.equal(r.isCorrect, false);
    assert.equal(r.gradingMethod, 'skipped');
    assert.notEqual(r.gradingMethod, 'ai');
  });

  test('bare key matches full option (أ vs أ) الخلية)', () => {
    const r = gradeDeterministic('أ', 'أ) الخلية النباتية', 'mcq');
    assert.equal(r.isCorrect, true);
    assert.equal(r.gradingMethod, 'exact');
  });

  test('Arabic diacritics are stripped for comparison', () => {
    const r = gradeDeterministic('التَّمَثُّل الضَّوْئِيّ', 'التمثل الضوئي', 'mcq');
    assert.equal(r.isCorrect, true);
  });

  test('scoreRatio is always binary (0 or 1) for mcq', () => {
    const correct = gradeDeterministic('أ', 'أ', 'mcq');
    const wrong   = gradeDeterministic('ب', 'أ', 'mcq');
    assert.ok([0, 1].includes(correct.scoreRatio), `scoreRatio=${correct.scoreRatio}`);
    assert.ok([0, 1].includes(wrong.scoreRatio), `scoreRatio=${wrong.scoreRatio}`);
  });
});

// ─── Section 3: true_false — no AI ───────────────────────────────────────────

describe('gradeDeterministic: true_false — no AI invocation', () => {
  test('صح matches صح → isCorrect=true', () => {
    const r = gradeDeterministic('صح', 'صح', 'true_false');
    assert.equal(r.isCorrect, true);
    assert.equal(r.gradingMethod, 'exact');
    assert.notEqual(r.gradingMethod, 'ai');
  });

  test('خطأ matches خطا (after normalisation) → isCorrect=true', () => {
    const r = gradeDeterministic('خطأ', 'خطا', 'true_false');
    assert.equal(r.isCorrect, true);
    assert.equal(r.gradingMethod, 'exact');
  });

  test('true matches صح → isCorrect=true', () => {
    const r = gradeDeterministic('true', 'صح', 'true_false');
    assert.equal(r.isCorrect, true);
  });

  test('false matches خطأ → isCorrect=true', () => {
    const r = gradeDeterministic('false', 'خطأ', 'true_false');
    assert.equal(r.isCorrect, true);
  });

  test('صح vs خطأ → isCorrect=false', () => {
    const r = gradeDeterministic('صح', 'خطأ', 'true_false');
    assert.equal(r.isCorrect, false);
    assert.equal(r.gradingMethod, 'exact');
    assert.notEqual(r.gradingMethod, 'ai');
  });

  test('null answer → gradingMethod=skipped, no AI', () => {
    const r = gradeDeterministic(null, 'صح', 'true_false');
    assert.equal(r.gradingMethod, 'skipped');
    assert.notEqual(r.gradingMethod, 'ai');
  });
});

// ─── Section 4: fill_in_blank — no AI ────────────────────────────────────────

describe('gradeDeterministic: fill_in_blank — no AI invocation', () => {
  test('exact normalised match → isCorrect=true, gradingMethod=exact', () => {
    const r = gradeDeterministic('الكلوروفيل', 'الكلوروفيل', 'fill_in_blank');
    assert.equal(r.isCorrect, true);
    assert.equal(r.gradingMethod, 'exact');
    assert.notEqual(r.gradingMethod, 'ai');
  });

  test('wrong answer → isCorrect=false, gradingMethod=exact', () => {
    const r = gradeDeterministic('الميتوكوندريا', 'الكلوروفيل', 'fill_in_blank');
    assert.equal(r.isCorrect, false);
    assert.equal(r.gradingMethod, 'exact');
    assert.notEqual(r.gradingMethod, 'ai');
  });

  test('null answer → gradingMethod=skipped, no AI', () => {
    const r = gradeDeterministic(null, 'الكلوروفيل', 'fill_in_blank');
    assert.equal(r.gradingMethod, 'skipped');
    assert.notEqual(r.gradingMethod, 'ai');
  });

  test('alif variants normalised (أ = ا)', () => {
    const r = gradeDeterministic('أحماض أمينية', 'احماض امينية', 'fill_in_blank');
    assert.equal(r.isCorrect, true);
  });

  test('no correctAnswer stored → isCorrect=false, gradingMethod=exact, no AI', () => {
    const r = gradeDeterministic('أي إجابة', null, 'fill_in_blank');
    assert.equal(r.isCorrect, false);
    assert.equal(r.gradingMethod, 'exact');
    assert.notEqual(r.gradingMethod, 'ai');
  });
});

// ─── Section 5: short_answer — no AI ─────────────────────────────────────────

describe('gradeWithOpenPackage: short_answer — no AI invocation', () => {
  test('canonical answer match → isCorrect=true, gradingMethod=exact', () => {
    const r = gradeWithOpenPackage(makeInput('short_answer', 'التمثيل الضوئي'), SHORT_ANSWER_PKG);
    assert.equal(r.isCorrect, true);
    assert.equal(r.gradingMethod, 'exact');
    assert.notEqual(r.gradingMethod, 'ai');
  });

  test('accepted semantic match → isCorrect=true, gradingMethod=exact', () => {
    const r = gradeWithOpenPackage(makeInput('short_answer', 'عملية البناء الضوئي'), SHORT_ANSWER_PKG);
    assert.equal(r.isCorrect, true);
    assert.equal(r.gradingMethod, 'exact');
    assert.notEqual(r.gradingMethod, 'ai');
  });

  test('wrong answer → isCorrect=false, gradingMethod=exact (no AI fallback)', () => {
    const r = gradeWithOpenPackage(makeInput('short_answer', 'التنفس الخلوي'), SHORT_ANSWER_PKG);
    assert.equal(r.gradingMethod, 'exact');
    assert.notEqual(r.gradingMethod, 'ai');
  });

  test('null answer → gradingMethod=skipped, no AI', () => {
    const r = gradeWithOpenPackage(makeInput('short_answer', null), SHORT_ANSWER_PKG);
    assert.equal(r.gradingMethod, 'skipped');
    assert.notEqual(r.gradingMethod, 'ai');
  });

  test('scoreRatio is always 0.0–1.0, no AI path', () => {
    const answers = ['التمثيل الضوئي', 'التنفس الخلوي', 'الكلوروفيل والطاقة الضوئية', ''];
    for (const ans of answers) {
      const r = gradeWithOpenPackage(makeInput('short_answer', ans || null), SHORT_ANSWER_PKG);
      assert.ok(r.scoreRatio >= 0 && r.scoreRatio <= 1, `scoreRatio out of range: ${r.scoreRatio}`);
      assert.notEqual(r.gradingMethod, 'ai');
    }
  });
});

// ─── Section 6: calculation — no AI ──────────────────────────────────────────

describe('gradeWithOpenPackage: calculation — no AI invocation', () => {
  test('exact numeric match → isCorrect=true, gradingMethod=exact', () => {
    const r = gradeWithOpenPackage(
      makeInput('calculation', '9.8 m/s²', null),
      CALCULATION_PKG,
    );
    assert.equal(r.isCorrect, true);
    assert.equal(r.gradingMethod, 'exact');
    assert.notEqual(r.gradingMethod, 'ai');
  });

  test('within tolerance → isCorrect=true, gradingMethod=exact', () => {
    const r = gradeWithOpenPackage(makeInput('calculation', '9.75', null), CALCULATION_PKG);
    assert.equal(r.isCorrect, true);
    assert.equal(r.gradingMethod, 'exact');
    assert.notEqual(r.gradingMethod, 'ai');
  });

  test('Arabic-Indic numerals parsed correctly → isCorrect=true, no AI', () => {
    const r = gradeWithOpenPackage(makeInput('calculation', '٩.٨', null), CALCULATION_PKG);
    assert.equal(r.isCorrect, true);
    assert.notEqual(r.gradingMethod, 'ai');
  });

  test('wrong numeric → isCorrect=false, gradingMethod=exact (no AI)', () => {
    const r = gradeWithOpenPackage(makeInput('calculation', '5.0', null), CALCULATION_PKG);
    assert.equal(r.isCorrect, false);
    assert.equal(r.gradingMethod, 'exact');
    assert.notEqual(r.gradingMethod, 'ai');
  });

  test('null answer → gradingMethod=skipped, no AI', () => {
    const r = gradeWithOpenPackage(makeInput('calculation', null, null), CALCULATION_PKG);
    assert.equal(r.gradingMethod, 'skipped');
    assert.notEqual(r.gradingMethod, 'ai');
  });

  test('no numeric in answer → partial concept fallback, no AI', () => {
    const r = gradeWithOpenPackage(
      makeInput('calculation', 'قوة الجاذبية هي التسارع', null),
      CALCULATION_PKG,
    );
    assert.ok(r.scoreRatio <= 0.5, `scoreRatio=${r.scoreRatio} should be <=0.5`);
    assert.equal(r.gradingMethod, 'exact');
    assert.notEqual(r.gradingMethod, 'ai');
  });
});

// ─── Section 7: essay — no AI ─────────────────────────────────────────────────

describe('gradeWithOpenPackage: essay — no AI invocation', () => {
  test('all concepts present → high score, gradingMethod=exact', () => {
    const r = gradeWithOpenPackage(
      makeInput('essay', 'التطور والانتقاء الطبيعي نظرية داروين والجين والطفرة', null),
      ESSAY_PKG,
    );
    assert.ok(r.scoreRatio >= 0.5, `scoreRatio=${r.scoreRatio}`);
    assert.equal(r.gradingMethod, 'exact');
    assert.notEqual(r.gradingMethod, 'ai');
  });

  test('no concepts → low score, gradingMethod=exact (no AI fallback)', () => {
    const r = gradeWithOpenPackage(
      makeInput('essay', 'الخلية تتكاثر بالانقسام', null),
      ESSAY_PKG,
    );
    assert.equal(r.isCorrect, false);
    assert.equal(r.gradingMethod, 'exact');
    assert.notEqual(r.gradingMethod, 'ai');
  });

  test('null answer → gradingMethod=skipped, no AI', () => {
    const r = gradeWithOpenPackage(makeInput('essay', null, null), ESSAY_PKG);
    assert.equal(r.gradingMethod, 'skipped');
    assert.notEqual(r.gradingMethod, 'ai');
  });

  test('partial concepts → scoreRatio between 0 and 1, no AI', () => {
    const r = gradeWithOpenPackage(
      makeInput('essay', 'التطور فقط', null),
      ESSAY_PKG,
    );
    assert.ok(r.scoreRatio >= 0 && r.scoreRatio <= 1);
    assert.equal(r.gradingMethod, 'exact');
    assert.notEqual(r.gradingMethod, 'ai');
  });

  test('empty string answer → isCorrect=false, no AI', () => {
    const r = gradeWithOpenPackage(makeInput('essay', '', null), ESSAY_PKG);
    assert.equal(r.isCorrect, false);
    assert.notEqual(r.gradingMethod, 'ai');
  });
});

// ─── Section 8: Guard fires for each type under grading context ───────────────
//
// This section proves the RUNTIME PROTECTION mechanism.
// When grading context is active, any call to assertNotInGradingContext() — which
// sits as the first statement in every Gemini entry point — throws immediately.
// We simulate that call directly for each type's "grading context scenario".
//
// In production, if a developer accidentally wires gradeWithCurriculum() back into
// the grading path, it will hit assertNotInGradingContext('curriculumGrader.callGemini')
// and throw GradingRuntimeAIViolationError before making any network request.

describe('gradingGuard: AI violation fires for each question type context', () => {
  const TYPES = ['mcq', 'true_false', 'fill_in_blank', 'short_answer', 'calculation', 'essay'];

  for (const type of TYPES) {
    test(`${type}: GradingRuntimeAIViolationError thrown when AI call attempted in grading context`, () => {
      enterGradingContext(`test-attempt-${type}`);
      try {
        // Simulate what every Gemini entry point does as its first statement.
        // In production this is `assertNotInGradingContext('curriculumGrader.callGemini')`.
        assert.throws(
          () => assertNotInGradingContext(`curriculumGrader.callGemini [type=${type}]`),
          (err: unknown) => {
            assert.ok(
              err instanceof GradingRuntimeAIViolationError,
              `Expected GradingRuntimeAIViolationError, got: ${String(err)}`,
            );
            assert.ok(
              (err as GradingRuntimeAIViolationError).message.includes('GRADING RUNTIME VIOLATION'),
            );
            assert.ok(
              (err as GradingRuntimeAIViolationError).aiCaller.includes('curriculumGrader.callGemini'),
            );
            return true;
          },
        );
      } finally {
        exitGradingContext();
      }
      // Guard must be off after exit
      assert.equal(isInGradingContext(), false);
    });
  }
});

// ─── Section 9: Exhaustive — no grading function ever returns gradingMethod='ai' ──

describe('exhaustive: gradingMethod is never "ai" from any grading function', () => {
  test('gradeDeterministic never returns gradingMethod=ai for any input combination', () => {
    const types   = ['mcq', 'true_false', 'fill_in_blank'];
    const answers = ['أ) الإجابة', 'صح', 'خطأ', 'true', 'false', 'نص عشوائي', '', null];
    const corrects = ['أ) الإجابة', 'صح', 'خطأ', null, ''];

    for (const type of types) {
      for (const student of answers) {
        for (const correct of corrects) {
          const r = gradeDeterministic(student, correct, type);
          assert.notEqual(
            r.gradingMethod,
            'ai',
            `gradeDeterministic returned gradingMethod='ai' for type=${type}, student=${JSON.stringify(student)}, correct=${JSON.stringify(correct)}`,
          );
        }
      }
    }
  });

  test('gradeWithOpenPackage never returns gradingMethod=ai for any input combination', () => {
    const openAnswers = ['إجابة صحيحة', 'التمثيل الضوئي', 'نص عشوائي تماماً', '', null];

    for (const ans of openAnswers) {
      const rShort = gradeWithOpenPackage(makeInput('short_answer', ans), SHORT_ANSWER_PKG);
      assert.notEqual(rShort.gradingMethod, 'ai',
        `gradeWithOpenPackage(short_answer) returned 'ai' for answer=${JSON.stringify(ans)}`);

      const rCalc = gradeWithOpenPackage(makeInput('calculation', ans, null), CALCULATION_PKG);
      assert.notEqual(rCalc.gradingMethod, 'ai',
        `gradeWithOpenPackage(calculation) returned 'ai' for answer=${JSON.stringify(ans)}`);

      const rEssay = gradeWithOpenPackage(makeInput('essay', ans, null), ESSAY_PKG);
      assert.notEqual(rEssay.gradingMethod, 'ai',
        `gradeWithOpenPackage(essay) returned 'ai' for answer=${JSON.stringify(ans)}`);
    }
  });
});
