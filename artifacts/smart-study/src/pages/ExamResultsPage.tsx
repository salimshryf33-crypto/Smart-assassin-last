import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Trophy, CheckCircle2, XCircle, ChevronDown, BookmarkPlus,
  RotateCcw, ArrowRight, AlertCircle, Sparkles, GraduationCap,
} from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { useAuth } from '../contexts/AuthContext';
import {
  getAttemptResults, getExamFlashcards,
  type AttemptResults, type FlashcardSeedItem,
} from '../utils/curriculumApi';
import { addDoc, collection } from 'firebase/firestore';
import { db } from '../lib/firebase';

const C = { blue: '#00c6ff', gold: '#f59e0b', green: '#34d399', red: '#f87171', bg: '#0a0f1e' };

// ─── Animated score ring ──────────────────────────────────────────────────────
function ScoreRing({ pct }: { pct: number }) {
  const r = 52;
  const circ = 2 * Math.PI * r;
  const color = pct >= 80 ? C.green : pct >= 60 ? C.gold : C.red;
  const label = pct >= 80 ? 'ممتاز!' : pct >= 60 ? 'جيد' : pct >= 40 ? 'مقبول' : 'ضعيف';

  return (
    <div className="relative flex items-center justify-center">
      <svg width="140" height="140" viewBox="0 0 140 140" style={{ transform: 'rotate(-90deg)' }}>
        <circle cx="70" cy="70" r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="10" />
        <motion.circle
          cx="70" cy="70" r={r}
          fill="none"
          stroke={color}
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={circ}
          initial={{ strokeDashoffset: circ }}
          animate={{ strokeDashoffset: circ * (1 - pct / 100) }}
          transition={{ duration: 1.2, ease: 'easeOut', delay: 0.3 }}
          style={{ filter: `drop-shadow(0 0 8px ${color}60)` }}
        />
      </svg>
      <div className="absolute flex flex-col items-center">
        <motion.span
          className="text-3xl font-black"
          style={{ color }}
          initial={{ opacity: 0, scale: 0.5 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.5, delay: 0.8 }}
        >
          {Math.round(pct)}%
        </motion.span>
        <span className="text-xs font-semibold" style={{ color }}>{label}</span>
      </div>
    </div>
  );
}

// ─── Answer row ───────────────────────────────────────────────────────────────
type AnswerRow = AttemptResults['answers'][number];
function AnswerRow({ a }: { a: AnswerRow }) {
  const [open, setOpen] = useState(false);
  const correct = a.isCorrect === true;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="mb-2 rounded-2xl overflow-hidden"
      style={{
        background: correct ? 'rgba(52,211,153,0.04)' : 'rgba(248,113,113,0.04)',
        border: correct ? '1px solid rgba(52,211,153,0.15)' : '1px solid rgba(248,113,113,0.15)',
      }}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full p-4 text-right flex items-start gap-3"
        dir="rtl"
      >
        <div className="flex-shrink-0 mt-0.5">
          {correct
            ? <CheckCircle2 size={16} style={{ color: C.green }} />
            : <XCircle size={16} style={{ color: C.red }} />}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-white leading-relaxed line-clamp-2">
            {a.questionText ?? 'سؤال'}
          </p>
          {a.topic && (
            <span
              className="mt-1 inline-block rounded-full px-2 py-0.5 text-[9px] font-semibold"
              style={{ background: 'rgba(0,198,255,0.1)', color: C.blue }}
            >
              {a.topic}
            </span>
          )}
        </div>
        <ChevronDown
          size={14}
          className="flex-shrink-0 text-slate-600 transition-transform mt-1"
          style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }}
        />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0 }}
            animate={{ height: 'auto' }}
            exit={{ height: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4 space-y-2" dir="rtl">
              {/* Student answer */}
              {a.studentAnswer && (
                <div
                  className="rounded-xl px-3 py-2 text-xs"
                  style={{
                    background: correct ? 'rgba(52,211,153,0.08)' : 'rgba(248,113,113,0.08)',
                    border: correct ? '1px solid rgba(52,211,153,0.2)' : '1px solid rgba(248,113,113,0.2)',
                    color: correct ? C.green : C.red,
                  }}
                >
                  <span className="opacity-60">إجابتك: </span>{a.studentAnswer}
                </div>
              )}
              {/* Correct answer */}
              {!correct && a.correctAnswer && (
                <div
                  className="rounded-xl px-3 py-2 text-xs"
                  style={{ background: 'rgba(52,211,153,0.08)', border: '1px solid rgba(52,211,153,0.2)', color: C.green }}
                >
                  <span className="opacity-70">الإجابة الصحيحة: </span>{a.correctAnswer}
                </div>
              )}
              {/* AI feedback */}
              {a.aiFeedback && (
                <p className="text-[11px] text-slate-400 leading-relaxed">{a.aiFeedback}</p>
              )}
              {/* Explanation */}
              {a.explanation && (
                <p className="text-[11px] text-slate-500 leading-relaxed border-t border-white/5 pt-2">{a.explanation}</p>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function ExamResultsPage() {
  const { setPage, setExamNav, examNav } = useAppStore();
  const { user } = useAuth();

  const [results, setResults]       = useState<AttemptResults | null>(null);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState('');
  const [savingCards, setSavingCards] = useState(false);
  const [savedCards, setSavedCards] = useState(0);
  const [cardsDone, setCardsDone]   = useState(false);

  // ── Load results ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const attemptId = examNav.selectedAttemptId;
    if (!attemptId) { setPage('exams'); return; }
    getAttemptResults(attemptId)
      .then(setResults)
      .catch((e) => setError(e.message ?? 'فشل تحميل النتائج'))
      .finally(() => setLoading(false));
  }, []);

  // ── Save wrong answers as flashcards ─────────────────────────────────────────
  const handleSaveFlashcards = async () => {
    const attemptId = examNav.selectedAttemptId;
    if (!attemptId || !user) return;
    setSavingCards(true);
    try {
      const { flashcards } = await getExamFlashcards(attemptId);
      if (flashcards.length === 0) { setCardsDone(true); setSavingCards(false); return; }

      const col = collection(db, 'users', user.uid, 'flashcards');
      let saved = 0;
      for (const seed of flashcards) {
        const card = {
          id:            crypto.randomUUID(),
          front:         seed.front,
          back:          seed.back,
          category:      seed.category,
          source:        'exam_question',
          status:        'new',
          createdAt:     Date.now(),
          reviewCount:   0,
          easeFactor:    2.5,
          interval:      1,
          repetitions:   0,
          nextReviewDate: Date.now(),
        };
        await addDoc(col, card);
        saved++;
        setSavedCards(saved);
      }
      setCardsDone(true);
    } catch {
      // silent fail — cards are a bonus feature
    } finally {
      setSavingCards(false);
    }
  };

  // ── Derived values ────────────────────────────────────────────────────────────
  const pct         = results ? parseFloat(results.scorePct ?? '0') : 0;
  const correct     = results?.correctCount ?? 0;
  const total       = results?.totalQuestions ?? 0;
  const wrong       = total - correct;
  const wrongAnswers = results?.answers.filter((a) => a.isCorrect === false) ?? [];
  const rightAnswers = results?.answers.filter((a) => a.isCorrect === true)  ?? [];
  const color       = pct >= 80 ? C.green : pct >= 60 ? C.gold : C.red;

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center flex-col gap-4" style={{ background: C.bg }}>
        <div className="flex gap-1.5">
          {[0,1,2].map((i) => (
            <div key={i} className="h-2 w-2 rounded-full animate-bounce" style={{ background: C.gold, animationDelay: `${i * 0.15}s` }} />
          ))}
        </div>
        <p className="text-xs text-slate-500">جاري التصحيح...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center flex-col gap-4 px-6 text-center" style={{ background: C.bg }} dir="rtl">
        <AlertCircle size={36} style={{ color: C.red }} />
        <p className="text-sm text-white">{error}</p>
        <button onClick={() => setPage('exams')} className="rounded-xl px-4 py-2 text-xs text-slate-400" style={{ background: 'rgba(255,255,255,0.06)' }}>عودة</button>
      </div>
    );
  }

  return (
    <div
      className="min-h-screen pb-10 overflow-y-auto"
      style={{ background: C.bg, maxWidth: 430, margin: '0 auto' }}
    >
      {/* ── Hero: score ── */}
      <div
        className="relative overflow-hidden px-6 pt-16 pb-8 text-center"
        style={{
          background: 'linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(10,15,30,1) 100%)',
        }}
      >
        <div
          className="absolute inset-0 opacity-30"
          style={{ background: `radial-gradient(circle at 50% 30%, ${color}30 0%, transparent 70%)` }}
        />
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          className="relative z-10"
        >
          <div className="flex justify-center mb-4">
            <ScoreRing pct={pct} />
          </div>
          <h1 className="text-lg font-black text-white mb-1">
            {pct >= 80 ? '🎉 نتيجة رائعة!' : pct >= 60 ? '👍 نتيجة جيدة' : '📚 حاول مرة أخرى'}
          </h1>

          {/* Stats row */}
          <div className="mt-4 flex justify-center gap-4">
            <div className="flex flex-col items-center">
              <span className="text-2xl font-black" style={{ color: C.green }}>{correct}</span>
              <span className="text-[10px] text-slate-500">صحيح</span>
            </div>
            <div className="w-px self-stretch" style={{ background: 'rgba(255,255,255,0.1)' }} />
            <div className="flex flex-col items-center">
              <span className="text-2xl font-black" style={{ color: C.red }}>{wrong}</span>
              <span className="text-[10px] text-slate-500">خطأ</span>
            </div>
            <div className="w-px self-stretch" style={{ background: 'rgba(255,255,255,0.1)' }} />
            <div className="flex flex-col items-center">
              <span className="text-2xl font-black text-white">{total}</span>
              <span className="text-[10px] text-slate-500">إجمالي</span>
            </div>
          </div>
        </motion.div>
      </div>

      <div className="px-4 space-y-4">
        {/* ── Flashcard save CTA ── */}
        {wrong > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4 }}
            className="rounded-2xl p-4"
            style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)' }}
            dir="rtl"
          >
            <div className="flex items-center gap-3">
              <div
                className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl"
                style={{ background: 'rgba(245,158,11,0.15)' }}
              >
                <BookmarkPlus size={18} style={{ color: C.gold }} />
              </div>
              <div className="flex-1">
                <p className="text-sm font-bold text-white">حفظ الأخطاء كبطاقات</p>
                <p className="text-xs text-slate-500">
                  {cardsDone
                    ? `✓ تم حفظ ${savedCards} بطاقة للمراجعة`
                    : `${wrong} سؤال غلط → بطاقات مراجعة ذكية`}
                </p>
              </div>
              {!cardsDone && (
                <button
                  onClick={handleSaveFlashcards}
                  disabled={savingCards}
                  className="flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-bold flex-shrink-0"
                  style={{
                    background: 'rgba(245,158,11,0.2)',
                    border: '1px solid rgba(245,158,11,0.35)',
                    color: C.gold,
                    opacity: savingCards ? 0.7 : 1,
                  }}
                >
                  {savingCards ? (
                    <>
                      <div className="h-3 w-3 rounded-full border border-amber-400/30 border-t-amber-400 animate-spin" />
                      {savedCards > 0 && <span>{savedCards}</span>}
                    </>
                  ) : (
                    <>
                      <Sparkles size={12} />
                      حفظ
                    </>
                  )}
                </button>
              )}
            </div>
          </motion.div>
        )}

        {/* ── Wrong answers section ── */}
        {wrongAnswers.length > 0 && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.5 }}
          >
            <div className="flex items-center justify-between mb-3" dir="rtl">
              <h2 className="text-sm font-bold text-white flex items-center gap-2">
                <XCircle size={14} style={{ color: C.red }} />
                الإجابات الخاطئة
                <span
                  className="rounded-full px-2 py-0.5 text-[10px]"
                  style={{ background: 'rgba(248,113,113,0.1)', color: C.red }}
                >
                  {wrongAnswers.length}
                </span>
              </h2>
            </div>
            {wrongAnswers.map((a) => <AnswerRow key={a.id} a={a} />)}
          </motion.div>
        )}

        {/* ── Correct answers section ── */}
        {rightAnswers.length > 0 && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.6 }}
          >
            <div className="flex items-center justify-between mb-3" dir="rtl">
              <h2 className="text-sm font-bold text-white flex items-center gap-2">
                <CheckCircle2 size={14} style={{ color: C.green }} />
                الإجابات الصحيحة
                <span
                  className="rounded-full px-2 py-0.5 text-[10px]"
                  style={{ background: 'rgba(52,211,153,0.1)', color: C.green }}
                >
                  {rightAnswers.length}
                </span>
              </h2>
            </div>
            {rightAnswers.map((a) => <AnswerRow key={a.id} a={a} />)}
          </motion.div>
        )}

        {/* ── Action buttons ── */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.7 }}
          className="flex gap-3 pt-2 pb-6"
        >
          <button
            onClick={() => {
              if (results?.examId) {
                setExamNav({ selectedExamId: results.examId, selectedAttemptId: null });
                setPage('exam-solver');
              }
            }}
            className="flex flex-1 items-center justify-center gap-2 rounded-2xl py-3.5 text-sm font-semibold"
            style={{ background: 'rgba(255,255,255,0.06)', color: '#94a3b8' }}
            dir="rtl"
          >
            <RotateCcw size={14} />
            حل مرة أخرى
          </button>
          <button
            onClick={() => setPage('exams')}
            className="flex flex-1 items-center justify-center gap-2 rounded-2xl py-3.5 text-sm font-bold"
            style={{
              background: 'linear-gradient(135deg, rgba(0,198,255,0.15), rgba(0,144,255,0.1))',
              border: '1.5px solid rgba(0,198,255,0.3)',
              color: C.blue,
            }}
            dir="rtl"
          >
            <GraduationCap size={14} />
            الامتحانات
          </button>
        </motion.div>
      </div>
    </div>
  );
}
