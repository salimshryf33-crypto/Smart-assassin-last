/**
 * autoGrader — grades a student's exam answers.
 *
 * Strategy:
 *   MCQ / true_false   → exact string match (case-insensitive, trimmed)
 *   short_answer        → Gemini semantic evaluation
 *   essay / calculation → Gemini rubric evaluation
 *
 * Architecture rule: depends on IExamQuestionStore and IExamSolverStore only.
 */
import { examStore } from './examStore';
import { examSolverStore } from './examSolverStore';
import { logger } from './logger';
import type { ExamAnswer } from '@workspace/db';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com';

// ─── Gemini helper ────────────────────────────────────────────────────────────

async function callGemini(prompt: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');
  const res = await fetch(
    `${GEMINI_BASE}/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 512, temperature: 0.1 },
      }),
    }
  );
  if (!res.ok) throw new Error(`Gemini ${res.status}`);
  const data = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}

// ─── Exact grader (MCQ / true_false) ─────────────────────────────────────────

function gradeExact(studentAnswer: string | null, correctAnswer: string | null): boolean {
  if (!studentAnswer || !correctAnswer) return false;
  return studentAnswer.trim().toLowerCase() === correctAnswer.trim().toLowerCase();
}

// ─── AI grader (short_answer / essay / calculation) ───────────────────────────

async function gradeWithAI(
  question: string,
  correctAnswer: string | null,
  studentAnswer: string,
  questionType: string
): Promise<{ isCorrect: boolean; feedback: string }> {
  if (!studentAnswer.trim()) {
    return { isCorrect: false, feedback: 'لم تقدم إجابة.' };
  }

  const prompt = `أنت مصحح امتحانات للمحتوى التعليمي العربي.

السؤال: ${question}
نوع السؤال: ${questionType}
${correctAnswer ? `الإجابة النموذجية: ${correctAnswer}` : ''}
إجابة الطالب: ${studentAnswer}

قيّم إجابة الطالب وأعد JSON فقط:
{
  "isCorrect": true أو false,
  "feedback": "تعليق مختصر بالعربي (جملة أو جملتان)"
}

قواعد:
- كن مرناً في الصياغة — ركّز على الصحة المفاهيمية.
- للمقالات: isCorrect = true إذا غطّت الإجابة النقاط الرئيسية.
- feedback يكون تشجيعياً وتصحيحياً.
- أعد JSON فقط بدون markdown.`;

  try {
    const raw = await callGemini(prompt);
    const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(cleaned) as { isCorrect?: boolean; feedback?: string };
    return {
      isCorrect: parsed.isCorrect ?? false,
      feedback:  parsed.feedback  ?? '',
    };
  } catch {
    return { isCorrect: false, feedback: 'تعذر التصحيح التلقائي.' };
  }
}

// ─── Grade one answer ─────────────────────────────────────────────────────────

export interface GradeResult {
  isCorrect:     boolean;
  gradingMethod: 'exact' | 'ai' | 'skipped';
  aiFeedback:    string | null;
}

export async function gradeAnswer(
  questionId: string,
  studentAnswer: string | null
): Promise<GradeResult> {
  const q = await examStore.getQuestionById(questionId);
  if (!q) return { isCorrect: false, gradingMethod: 'skipped', aiFeedback: null };
  if (!studentAnswer?.trim()) {
    return { isCorrect: false, gradingMethod: 'skipped', aiFeedback: 'لم تقدم إجابة.' };
  }

  if (q.questionType === 'mcq' || q.questionType === 'true_false') {
    return {
      isCorrect:     gradeExact(studentAnswer, q.correctAnswer),
      gradingMethod: 'exact',
      aiFeedback:    null,
    };
  }

  const { isCorrect, feedback } = await gradeWithAI(
    q.question,
    q.correctAnswer,
    studentAnswer,
    q.questionType
  );
  return { isCorrect, gradingMethod: 'ai', aiFeedback: feedback };
}

// ─── Grade entire attempt ─────────────────────────────────────────────────────

export interface AttemptGradeResult {
  totalQuestions: number;
  correctCount:   number;
  scorePct:       number;
  answers:        Array<ExamAnswer & { feedback: string | null }>;
}

export async function gradeAttempt(attemptId: string): Promise<AttemptGradeResult> {
  const answers = await examSolverStore.getAnswersByAttempt(attemptId);

  let correctCount = 0;
  const graded: Array<ExamAnswer & { feedback: string | null }> = [];

  for (const answer of answers) {
    if (answer.isCorrect !== null) {
      if (answer.isCorrect) correctCount++;
      graded.push({ ...answer, feedback: answer.aiFeedback ?? null });
      continue;
    }

    const result = await gradeAnswer(answer.questionId, answer.studentAnswer ?? null);

    await examSolverStore.updateAnswer(answer.id, {
      isCorrect:     result.isCorrect,
      gradingMethod: result.gradingMethod,
      aiFeedback:    result.aiFeedback,
    });

    if (result.isCorrect) correctCount++;
    graded.push({
      ...answer,
      isCorrect:     result.isCorrect,
      gradingMethod: result.gradingMethod,
      aiFeedback:    result.aiFeedback,
      feedback:      result.aiFeedback,
    });
  }

  const total = answers.length;
  const score = total > 0 ? Math.round((correctCount / total) * 10000) / 100 : 0;

  await examSolverStore.updateAttempt(attemptId, {
    status:         'completed',
    correctCount,
    totalQuestions: total,
    scorePct:       String(score) as unknown as null,
    completedAt:    new Date(),
  });

  logger.info({ attemptId, total, correctCount, scorePct: score }, 'autoGrader: attempt graded');

  return { totalQuestions: total, correctCount, scorePct: score, answers: graded };
}
