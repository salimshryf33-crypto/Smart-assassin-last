/**
 * autoGrader.ts
 *
 * Public façade for the Curriculum Authority Correction Engine.
 *
 * External interface is UNCHANGED — callers (routes/examSolver.ts) continue
 * to import gradeAttempt() and GradeResult / AttemptGradeResult exactly as
 * before. Zero regression.
 *
 * Internals now delegate to:
 *   artifacts/api-server/src/lib/correctionEngine/
 *
 * Architecture:
 *   gradeAttempt()  → correctionEngine.gradeAttemptWithCurriculum()
 *   gradeAnswer()   → kept for backward-compatibility (not used by any route)
 *                     delegates to the engine's deterministic / curriculum path
 */

import {
  gradeAttemptWithCurriculum,
  type AttemptGradeResult,
} from './correctionEngine/index';
import { gradeDeterministic, DETERMINISTIC_TYPES } from './correctionEngine/deterministicGrader';
import { gradeWithOpenPackage }  from './correctionEngine/openGrader';
import * as openPrepStore        from './examValidation/openPreparationStore';
import { OPEN_PREPARATION_TYPES } from './questionTypeRegistry';
import { examStore }             from './examStore';
import type { ExamAnswer }       from '@workspace/db';

// ─── Public types (unchanged) ─────────────────────────────────────────────────

export interface GradeResult {
  isCorrect:     boolean;
  gradingMethod: 'exact' | 'ai' | 'skipped' | 'insufficient' | 'pending_preparation';
  aiFeedback:    string | null;
}

export type { AttemptGradeResult };

// ─── gradeAttempt — public entry point (interface unchanged) ─────────────────

/**
 * Grade an entire exam attempt.
 * Now delegates to the Curriculum Authority Correction Engine.
 * Return type is identical to the legacy implementation.
 */
export async function gradeAttempt(attemptId: string): Promise<AttemptGradeResult> {
  return gradeAttemptWithCurriculum(attemptId);
}

// ─── gradeAnswer — legacy compatibility (not used by any route) ───────────────

/**
 * Grade a single answer. Kept for backward-compatibility only.
 * Delegates to the appropriate engine layer based on question type.
 */
export async function gradeAnswer(
  questionId:    string,
  studentAnswer: string | null
): Promise<GradeResult> {
  const q = await examStore.getQuestionById(questionId);
  if (!q) return { isCorrect: false, gradingMethod: 'skipped', aiFeedback: null };

  if (DETERMINISTIC_TYPES.has(q.questionType)) {
    const r = gradeDeterministic(studentAnswer, q.correctAnswer ?? null, q.questionType);
    return { isCorrect: r.isCorrect, gradingMethod: r.gradingMethod, aiFeedback: r.aiFeedback };
  }

  // Runtime Guarantee: Gemini NEVER called at grading time.
  // For open-prepared types (short_answer / calculation / essay) consume the
  // stored preparation package deterministically — identical to the main engine.
  if (OPEN_PREPARATION_TYPES.has(q.questionType)) {
    const openPrep = await openPrepStore.getByQuestionId(q.id);
    if (openPrep?.preparationStatus === 'READY' && openPrep.package) {
      const input = {
        questionId:    q.id,
        question:      q.question,
        questionType:  q.questionType,
        correctAnswer: q.correctAnswer ?? null,
        options:       q.options       ?? null,
        topic:         q.topic         ?? null,
        chapter:       q.chapter       ?? null,
        subject:       q.subject,
        grade:         q.grade,
        country:       q.country,
        studentAnswer,
      };
      const r = gradeWithOpenPackage(input, openPrep.package);
      return { isCorrect: r.isCorrect, gradingMethod: r.gradingMethod, aiFeedback: r.aiFeedback };
    }
    // Preparation not yet ready — surface clear status to caller
    return { isCorrect: false, gradingMethod: 'pending_preparation', aiFeedback: 'هذا السؤال في طور الإعداد' };
  }

  // Unknown type — no preparation path available
  return { isCorrect: false, gradingMethod: 'skipped', aiFeedback: null };
}
