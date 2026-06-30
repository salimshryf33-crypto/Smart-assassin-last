/**
 * QUIZ ENGINE — Pure functions for QUIZ_MODE
 *
 * Responsibility:
 *   Build the Socratic quiz-master system prompt from curriculum RAG content.
 *   Sage generates ONE question at a time, evaluates answers, explains mistakes.
 *
 * Design principles:
 *   - ALL functions are pure (no side effects, no API calls, no DOM access).
 *   - Zero external dependencies → fully unit-testable in Node.js.
 *   - Used exclusively by answerEngine.ts when mode === QUIZ_MODE.
 *
 * QUIZ_MODE vs EXAM_MODE:
 *   - QUIZ_MODE  → questions generated on-the-fly from curriculum RAG chunks.
 *   - EXAM_MODE  → questions pulled from the real past-exam bank + weakness targeting.
 */

// ─── Label helpers (pure, exported for testing) ───────────────────────────────

export function countryLabel(country: string): string {
  if (country === 'egypt') return 'مصر';
  if (country === 'sudan') return 'السودان';
  return country;
}

export function levelLabel(level: string): string {
  if (level === 'primary')     return 'المرحلة الابتدائية';
  if (level === 'preparatory') return 'المرحلة الإعدادية';
  if (level === 'secondary')   return 'المرحلة الثانوية';
  return level;
}

// ─── Quiz Prompt Parameters ───────────────────────────────────────────────────

export interface QuizPromptParams {
  country:    string;
  level:      string;
  subject:    string;
  track?:     string;
  ragContext: string;
}

// ─── Prompt Builder ───────────────────────────────────────────────────────────

/**
 * Build the system prompt for QUIZ_MODE.
 *
 * Sage acts as a quiz master:
 *   1. Generates one question per turn from curriculum chunks.
 *   2. Accepts the student's answer.
 *   3. Evaluates correctness and explains mistakes from the source text.
 *
 * @param params - curriculum context + retrieved RAG content (required)
 * @returns Ready-to-send system prompt string.
 */
export function buildQuizPrompt(params: QuizPromptParams): string {
  const cLabel = countryLabel(params.country);
  const lLabel = levelLabel(params.level);
  const track  = params.track || 'غير محدد';

  return `أنت Sage — مدرس خصوصي ذكي في وضع "الاختبار التفاعلي".

==================================================
النطاق المحدد (غير قابل للتغيير)
==================================================
- الدولة:  ${cLabel}
- المرحلة: ${lLabel}
- المادة:  ${params.subject || 'غير محدد'}
- المسار:  ${track}

==================================================
محتوى الكتاب المدرسي — المصدر الوحيد لأسئلتك
==================================================
${params.ragContext}

==================================================
دورك كمُختبِر — قواعد صارمة لا تتجاوزها
==================================================
1. اطرح سؤالاً واحداً فقط في كل رسالة — لا أكثر، لا أقل.
2. نوّع أسئلتك: اختيار متعدد / صح وخطأ / تعريف / تطبيق / ملء الفراغ.
3. لا تكشف الإجابة الصحيحة قبل أن يجيب الطالب.
4. عندما يجيب الطالب:
   → إذا أصاب: امدحه بإيجاز ثم انتقل فوراً لسؤال جديد.
   → إذا أخطأ: أخبره بالإجابة الصحيحة واشرحها من النص المُستخرج أعلاه.
5. أسئلتك مستخرجة حصراً من المقاطع أعلاه — لا تختلق معلومات خارجها.
6. إذا طلب الطالب شرحاً أو توضيحاً → أجب من النص، ثم عُد للاختبار.
7. إذا انتهت مقاطع الكتاب → أخبر الطالب بذلك ولا تختلق أسئلة جديدة.
8. لا تخرج عن نطاق المادة والمرحلة المحددتين أعلاه.
9. أجب بالعربية الفصحى. استخدم markdown وLaTeX للمعادلات الرياضية.`;
}

// ─── Gate message ─────────────────────────────────────────────────────────────

/**
 * Returned when RAG finds no curriculum content.
 * A quiz cannot be generated without source material — Gemini is NOT called.
 */
export const NO_QUIZ_CONTENT_RESPONSE =
  'لا يمكنني إنشاء اختبار حالياً — لم يُعثر على محتوى في الكتاب المدرسي المرفوع لهذه المادة. يرجى التأكد من رفع محتوى المادة أولاً.';
