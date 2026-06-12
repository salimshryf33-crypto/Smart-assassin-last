import { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ChevronRight, ChevronLeft, Send, Clock, X, CheckCircle2, AlertCircle,
} from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import {
  startExamAttempt, submitExamAnswer, submitAttempt, getExamRecord,
  type StartAttemptResponse,
} from '../utils/curriculumApi';

const C = { blue: '#00c6ff', gold: '#f59e0b', green: '#34d399', red: '#f87171', bg: '#0a0f1e' };

// ─── Timer ────────────────────────────────────────────────────────────────────
function Timer({ seconds }: { seconds: number }) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const warn = seconds > 0 && seconds < 300;
  return (
    <div
      className="flex items-center gap-1.5 rounded-xl px-3 py-1.5"
      style={{
        background: warn ? 'rgba(248,113,113,0.1)' : 'rgba(255,255,255,0.06)',
        border: warn ? '1px solid rgba(248,113,113,0.3)' : '1px solid rgba(255,255,255,0.08)',
      }}
    >
      <Clock size={12} style={{ color: warn ? C.red : '#94a3b8' }} />
      <span
        className="text-xs font-mono font-semibold tabular-nums"
        style={{ color: warn ? C.red : '#94a3b8' }}
      >
        {h > 0 && `${h}:`}{String(m).padStart(2,'0')}:{String(s).padStart(2,'0')}
      </span>
    </div>
  );
}

// ─── Progress bar ─────────────────────────────────────────────────────────────
function ProgressBar({ current, total }: { current: number; total: number }) {
  const pct = total > 0 ? ((current + 1) / total) * 100 : 0;
  return (
    <div className="h-1 w-full rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
      <motion.div
        className="h-full rounded-full"
        style={{ background: `linear-gradient(90deg, ${C.blue}, #0090ff)` }}
        animate={{ width: `${pct}%` }}
        transition={{ duration: 0.4 }}
      />
    </div>
  );
}

// ─── MCQ option ───────────────────────────────────────────────────────────────
function MCQOption({
  label, selected, onSelect,
}: { label: string; selected: boolean; onSelect: () => void }) {
  return (
    <motion.button
      whileTap={{ scale: 0.97 }}
      onClick={onSelect}
      className="w-full rounded-2xl px-4 py-3.5 text-right text-sm leading-relaxed transition-all"
      style={{
        background: selected ? 'rgba(0,198,255,0.12)' : 'rgba(255,255,255,0.04)',
        border: selected ? '1.5px solid rgba(0,198,255,0.5)' : '1.5px solid rgba(255,255,255,0.08)',
        color: selected ? 'white' : '#94a3b8',
        boxShadow: selected ? '0 0 16px rgba(0,198,255,0.1)' : 'none',
      }}
      dir="rtl"
    >
      <div className="flex items-center gap-3">
        <div
          className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full"
          style={{
            background: selected ? C.blue : 'transparent',
            border: selected ? `2px solid ${C.blue}` : '2px solid rgba(255,255,255,0.2)',
          }}
        >
          {selected && <div className="h-2 w-2 rounded-full bg-white" />}
        </div>
        <span className="flex-1">{label}</span>
      </div>
    </motion.button>
  );
}

// ─── True/False option ────────────────────────────────────────────────────────
function TFOption({
  label, value, selected, onSelect, color,
}: { label: string; value: string; selected: boolean; onSelect: () => void; color: string }) {
  return (
    <motion.button
      whileTap={{ scale: 0.96 }}
      onClick={onSelect}
      className="flex-1 rounded-2xl py-4 text-center font-bold text-sm transition-all"
      style={{
        background: selected ? `${color}18` : 'rgba(255,255,255,0.04)',
        border: selected ? `1.5px solid ${color}60` : '1.5px solid rgba(255,255,255,0.08)',
        color: selected ? color : '#64748b',
      }}
    >
      {label}
    </motion.button>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function ExamSolverPage() {
  const { setPage, setExamNav, examNav } = useAppStore();

  const [session, setSession]     = useState<StartAttemptResponse | null>(null);
  const [answers, setAnswers]     = useState<Record<string, string>>({});
  const [idx, setIdx]             = useState(0);
  const [seconds, setSeconds]     = useState(0);
  const [status, setStatus]       = useState<'loading' | 'ready' | 'submitting' | 'error'>('loading');
  const [errorMsg, setErrorMsg]   = useState('');
  const [showConfirm, setShowConfirm] = useState(false);
  const [examTitle, setExamTitle] = useState('');

  // Auto-save debounce
  const saveRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Timer ────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (status !== 'ready') return;
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [status]);

  // ── Start attempt on mount ───────────────────────────────────────────────────
  useEffect(() => {
    const examId = examNav.selectedExamId;
    if (!examId) { setPage('exams'); return; }

    (async () => {
      try {
        const [data, rec] = await Promise.all([
          startExamAttempt(examId),
          getExamRecord(examId),
        ]);
        setSession(data);
        setExamTitle(rec?.title ?? 'الامتحان');
        setExamNav({ selectedAttemptId: data.attemptId });
        setStatus('ready');
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : 'تعذّر تحميل الامتحان');
        setStatus('error');
      }
    })();
  }, []);

  // ── Save answer (debounced 800ms) ────────────────────────────────────────────
  const saveAnswer = useCallback(
    (questionId: string, answer: string, attemptId: string) => {
      if (saveRef.current) clearTimeout(saveRef.current);
      saveRef.current = setTimeout(() => {
        submitExamAnswer(attemptId, questionId, answer).catch(() => undefined);
      }, 800);
    },
    []
  );

  const selectAnswer = (questionId: string, answer: string) => {
    setAnswers((prev) => ({ ...prev, [questionId]: answer }));
    if (session?.attemptId) saveAnswer(questionId, answer, session.attemptId);
  };

  // ── Submit ───────────────────────────────────────────────────────────────────
  const handleSubmit = async () => {
    if (!session) return;
    setStatus('submitting');
    setShowConfirm(false);
    try {
      await submitAttempt(session.attemptId);
      setExamNav({ selectedAttemptId: session.attemptId });
      setPage('exam-results');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'فشل إرسال الامتحان');
      setStatus('ready');
    }
  };

  const q = session?.questions[idx];
  const answered = Object.keys(answers).length;
  const total    = session?.questions.length ?? 0;
  const unanswered = total - answered;

  // ── Loading state ─────────────────────────────────────────────────────────────
  if (status === 'loading') {
    return (
      <div
        className="flex min-h-screen flex-col items-center justify-center gap-4"
        style={{ background: C.bg }}
      >
        <div
          className="h-14 w-14 rounded-2xl flex items-center justify-center animate-pulse"
          style={{ background: 'rgba(245,158,11,0.15)', border: '1px solid rgba(245,158,11,0.3)' }}
        >
          <GraduationCapIcon />
        </div>
        <div className="flex gap-1.5">
          {[0,1,2].map((i) => (
            <div
              key={i}
              className="h-1.5 w-1.5 rounded-full animate-pulse"
              style={{ background: C.gold, animationDelay: `${i * 0.2}s` }}
            />
          ))}
        </div>
        <p className="text-xs text-slate-500">جاري تحميل الامتحان...</p>
      </div>
    );
  }

  // ── Error state ───────────────────────────────────────────────────────────────
  if (status === 'error') {
    return (
      <div
        className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center"
        style={{ background: C.bg }}
        dir="rtl"
      >
        <AlertCircle size={40} style={{ color: C.red }} />
        <p className="text-sm font-semibold text-white">تعذّر تحميل الامتحان</p>
        <p className="text-xs text-slate-500">{errorMsg}</p>
        <button
          onClick={() => setPage('exams')}
          className="mt-2 rounded-xl px-5 py-2.5 text-sm font-semibold"
          style={{ background: 'rgba(255,255,255,0.06)', color: '#94a3b8' }}
        >
          عودة
        </button>
      </div>
    );
  }

  return (
    <div
      className="flex min-h-screen flex-col"
      style={{ background: C.bg, maxWidth: 430, margin: '0 auto' }}
    >
      {/* ── Top bar ── */}
      <div
        className="flex items-center gap-3 px-4 pt-12 pb-3"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}
      >
        <button
          onClick={() => setPage('exams')}
          className="flex h-9 w-9 items-center justify-center rounded-xl flex-shrink-0"
          style={{ background: 'rgba(255,255,255,0.06)' }}
        >
          <X size={16} className="text-slate-400" />
        </button>

        <div className="flex-1 min-w-0">
          <p className="text-xs text-slate-500 truncate" dir="rtl">{examTitle}</p>
          <ProgressBar current={idx} total={total} />
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="text-xs text-slate-500 tabular-nums">{idx + 1}/{total}</span>
          <Timer seconds={seconds} />
        </div>
      </div>

      {/* ── Question area ── */}
      <div className="flex-1 overflow-y-auto px-4 py-6" dir="rtl">
        <AnimatePresence mode="wait">
          {q && (
            <motion.div
              key={q.id}
              initial={{ opacity: 0, x: 40 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -40 }}
              transition={{ duration: 0.25 }}
            >
              {/* Question metadata */}
              <div className="flex items-center gap-2 mb-4 flex-wrap">
                {q.topic && (
                  <span
                    className="rounded-full px-2.5 py-1 text-[10px] font-semibold"
                    style={{ background: 'rgba(0,198,255,0.1)', color: C.blue, border: '1px solid rgba(0,198,255,0.2)' }}
                  >
                    {q.topic}
                  </span>
                )}
                {q.difficulty && (
                  <span
                    className="rounded-full px-2.5 py-1 text-[10px] font-semibold"
                    style={{
                      background: ({ easy: 'rgba(52,211,153,0.1)', medium: 'rgba(245,158,11,0.1)', hard: 'rgba(248,113,113,0.1)' } as Record<string, string>)[q.difficulty] ?? 'rgba(255,255,255,0.05)',
                      color: ({ easy: C.green, medium: C.gold, hard: C.red } as Record<string, string>)[q.difficulty] ?? '#94a3b8',
                    }}
                  >
                    {q.difficulty === 'easy' ? 'سهل' : q.difficulty === 'medium' ? 'متوسط' : 'صعب'}
                  </span>
                )}
              </div>

              {/* Question text */}
              <div
                className="mb-6 rounded-2xl p-5"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}
              >
                <p className="text-base font-semibold text-white leading-relaxed">{q.question}</p>
              </div>

              {/* Answer input based on type */}
              {q.questionType === 'mcq' && Array.isArray(q.options) && (
                <div className="space-y-3">
                  {(q.options as string[]).map((opt) => (
                    <MCQOption
                      key={opt}
                      label={opt}
                      selected={answers[q.id] === opt}
                      onSelect={() => selectAnswer(q.id, opt)}
                    />
                  ))}
                </div>
              )}

              {q.questionType === 'true_false' && (
                <div className="flex gap-3">
                  <TFOption label="✓ صحيح"  value="صحيح"  selected={answers[q.id] === 'صحيح'}  onSelect={() => selectAnswer(q.id, 'صحيح')}  color={C.green} />
                  <TFOption label="✗ خطأ"   value="خطأ"   selected={answers[q.id] === 'خطأ'}   onSelect={() => selectAnswer(q.id, 'خطأ')}   color={C.red} />
                </div>
              )}

              {(q.questionType === 'short_answer' || q.questionType === 'calculation') && (
                <div
                  className="rounded-2xl overflow-hidden"
                  style={{ border: '1.5px solid rgba(255,255,255,0.1)' }}
                >
                  <input
                    value={answers[q.id] ?? ''}
                    onChange={(e) => selectAnswer(q.id, e.target.value)}
                    placeholder="اكتب إجابتك هنا..."
                    className="w-full bg-transparent px-4 py-4 text-sm text-white placeholder-slate-600 outline-none text-right"
                    style={{ background: 'rgba(255,255,255,0.04)' }}
                  />
                </div>
              )}

              {q.questionType === 'essay' && (
                <div
                  className="rounded-2xl overflow-hidden"
                  style={{ border: '1.5px solid rgba(255,255,255,0.1)' }}
                >
                  <textarea
                    value={answers[q.id] ?? ''}
                    onChange={(e) => selectAnswer(q.id, e.target.value)}
                    placeholder="اكتب إجابتك التفصيلية هنا..."
                    rows={6}
                    className="w-full bg-transparent px-4 py-4 text-sm text-white placeholder-slate-600 outline-none resize-none text-right"
                    style={{ background: 'rgba(255,255,255,0.04)' }}
                  />
                </div>
              )}

              {/* Answer indicator */}
              {answers[q.id] && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="mt-3 flex items-center gap-1.5 justify-end"
                >
                  <CheckCircle2 size={12} style={{ color: C.green }} />
                  <span className="text-[11px]" style={{ color: C.green }}>تم حفظ الإجابة</span>
                </motion.div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* ── Bottom navigation ── */}
      <div
        className="px-4 py-4 pb-8"
        style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}
      >
        {/* Question dots (max 10 visible) */}
        <div className="flex justify-center gap-1.5 mb-4 flex-wrap">
          {session?.questions.slice(0, 15).map((q2, i) => (
            <button
              key={q2.id}
              onClick={() => setIdx(i)}
              className="h-2 rounded-full transition-all"
              style={{
                width: i === idx ? 24 : 8,
                background: answers[q2.id]
                  ? C.green
                  : i === idx
                  ? C.blue
                  : 'rgba(255,255,255,0.15)',
              }}
            />
          ))}
          {(session?.questions.length ?? 0) > 15 && (
            <span className="text-[10px] text-slate-600 self-center">+{(session?.questions.length ?? 0) - 15}</span>
          )}
        </div>

        <div className="flex items-center gap-3">
          {/* Prev */}
          <button
            onClick={() => setIdx((i) => Math.max(0, i - 1))}
            disabled={idx === 0}
            className="flex h-12 w-12 items-center justify-center rounded-2xl flex-shrink-0 transition-opacity"
            style={{
              background: 'rgba(255,255,255,0.06)',
              opacity: idx === 0 ? 0.3 : 1,
            }}
          >
            <ChevronRight size={20} className="text-slate-400" />
          </button>

          {/* Submit / Next */}
          {idx === total - 1 ? (
            <motion.button
              whileTap={{ scale: 0.97 }}
              onClick={() => setShowConfirm(true)}
              disabled={status === 'submitting'}
              className="flex flex-1 items-center justify-center gap-2 rounded-2xl py-3.5 text-sm font-bold"
              style={{
                background: 'linear-gradient(135deg, rgba(245,158,11,0.25), rgba(245,158,11,0.15))',
                border: '1.5px solid rgba(245,158,11,0.4)',
                color: C.gold,
              }}
            >
              {status === 'submitting' ? (
                <>
                  <div className="h-4 w-4 rounded-full border-2 border-amber-400/30 border-t-amber-400 animate-spin" />
                  جاري التصحيح...
                </>
              ) : (
                <>
                  <Send size={15} />
                  تسليم الامتحان
                </>
              )}
            </motion.button>
          ) : (
            <button
              onClick={() => setIdx((i) => Math.min(total - 1, i + 1))}
              className="flex flex-1 items-center justify-center gap-2 rounded-2xl py-3.5 text-sm font-bold"
              style={{
                background: 'linear-gradient(135deg, rgba(0,198,255,0.15), rgba(0,144,255,0.1))',
                border: '1.5px solid rgba(0,198,255,0.3)',
                color: C.blue,
              }}
            >
              التالي
              <ChevronLeft size={15} />
            </button>
          )}

          {/* Next (always accessible from last Q too) */}
          {idx < total - 1 ? null : (
            <button
              onClick={() => setIdx((i) => Math.min(total - 1, i + 1))}
              disabled={idx === total - 1}
              className="flex h-12 w-12 items-center justify-center rounded-2xl flex-shrink-0 transition-opacity"
              style={{
                background: 'rgba(255,255,255,0.06)',
                opacity: idx === total - 1 ? 0.3 : 1,
              }}
            >
              <ChevronLeft size={20} className="text-slate-400" />
            </button>
          )}
        </div>
      </div>

      {/* ── Confirm submit modal ── */}
      <AnimatePresence>
        {showConfirm && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-end justify-center"
            style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)' }}
            onClick={() => setShowConfirm(false)}
          >
            <motion.div
              initial={{ y: 80, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 80, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 300, damping: 30 }}
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-[430px] rounded-t-3xl p-6 pb-10"
              style={{ background: '#111827', border: '1px solid rgba(255,255,255,0.1)' }}
              dir="rtl"
            >
              <div className="mb-5 text-center">
                <div
                  className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl"
                  style={{ background: 'rgba(245,158,11,0.15)', border: '1px solid rgba(245,158,11,0.3)' }}
                >
                  <Send size={22} style={{ color: C.gold }} />
                </div>
                <h3 className="text-base font-bold text-white">تسليم الامتحان؟</h3>
                <p className="mt-1 text-xs text-slate-400">
                  أجبت على <span className="font-bold text-white">{answered}</span> من <span className="font-bold">{total}</span> سؤال
                  {unanswered > 0 && (
                    <span style={{ color: C.gold }}> · {unanswered} بدون إجابة</span>
                  )}
                </p>
              </div>
              <div className="flex gap-3">
                <button
                  onClick={() => setShowConfirm(false)}
                  className="flex-1 rounded-2xl py-3.5 text-sm font-semibold text-slate-400"
                  style={{ background: 'rgba(255,255,255,0.06)' }}
                >
                  مراجعة
                </button>
                <button
                  onClick={handleSubmit}
                  className="flex-1 rounded-2xl py-3.5 text-sm font-bold"
                  style={{
                    background: 'linear-gradient(135deg, rgba(245,158,11,0.3), rgba(245,158,11,0.2))',
                    border: '1px solid rgba(245,158,11,0.4)',
                    color: C.gold,
                  }}
                >
                  تسليم الآن
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function GraduationCapIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="1.5">
      <path d="M22 10v6M2 10l10-5 10 5-10 5z"/>
      <path d="M6 12v5c3 3 9 3 12 0v-5"/>
    </svg>
  );
}
