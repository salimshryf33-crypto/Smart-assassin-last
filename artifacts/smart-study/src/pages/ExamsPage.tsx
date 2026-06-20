import { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  GraduationCap, BookOpen, ChevronRight, Plus,
  CheckCircle2, Search,
  TrendingDown, TrendingUp, BarChart3, ArrowRight, FileText,
  Clock, Zap, LayoutGrid, Trophy,
} from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import PageWrapper from '../components/layout/PageWrapper';
import ExamCoverageModal from '../components/ExamCoverageModal';
import {
  listExamRecords, searchBankQuestions, listWeaknessSnapshots, listMyAttempts,
  type ExamRecord, type ExamQuestion, type WeaknessSnapshot, type WeakTopicResult, type AttemptWithTitle,
} from '../utils/curriculumApi';

// ─── Colours ──────────────────────────────────────────────────────────────────
const C = {
  blue:  '#00c6ff',
  gold:  '#f59e0b',
  green: '#34d399',
  red:   '#f87171',
  bg:    '#0a0f1e',
};

// ─── Sub-tab type ─────────────────────────────────────────────────────────────
type SubTab = 'my-exams' | 'bank' | 'weakness' | 'attempts';

// ─── Pill ─────────────────────────────────────────────────────────────────────
function Pill({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <motion.button
      whileTap={{ scale: 0.94 }}
      onClick={onClick}
      className="px-4 py-1.5 rounded-full text-xs font-semibold transition-all"
      style={{
        background: active ? 'rgba(0,198,255,0.15)' : 'rgba(255,255,255,0.04)',
        border: active ? '1px solid rgba(0,198,255,0.35)' : '1px solid rgba(255,255,255,0.07)',
        color: active ? C.blue : '#64748b',
        boxShadow: active ? '0 0 12px rgba(0,198,255,0.1)' : 'none',
      }}
    >
      {label}
    </motion.button>
  );
}

// ─── Status badge ─────────────────────────────────────────────────────────────
function StatusBadge({ status }: { status: string }) {
  const cfg: Record<string, { label: string; color: string; bg: string }> = {
    done:       { label: 'مكتمل',          color: C.green,   bg: 'rgba(52,211,153,0.1)' },
    extracting: { label: 'جاري الاستخراج', color: C.blue,    bg: 'rgba(0,198,255,0.1)' },
    pending:    { label: 'معلّق',          color: C.gold,    bg: 'rgba(245,158,11,0.1)' },
    error:      { label: 'خطأ',            color: C.red,     bg: 'rgba(248,113,113,0.1)' },
    poor_scan:  { label: 'جودة منخفضة',   color: '#f97316', bg: 'rgba(249,115,22,0.1)' },
  };
  const c = cfg[status] ?? cfg.pending;
  return (
    <span
      className="rounded-full px-2 py-0.5 text-[10px] font-semibold"
      style={{ color: c.color, background: c.bg, border: `1px solid ${c.color}25` }}
    >
      {c.label}
    </span>
  );
}

// ─── ExamCard ─────────────────────────────────────────────────────────────────
function ExamCard({
  exam, onSolve, onCoverage,
}: { exam: ExamRecord; onSolve: () => void; onCoverage: () => void }) {
  const canSolve    = exam.extractionStatus === 'done' && (exam.questionCount ?? 0) > 0;
  const canCoverage = exam.extractionStatus === 'done' || exam.extractionStatus === 'error' || exam.extractionStatus === 'poor_scan';
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-2xl p-4"
      style={{
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(255,255,255,0.07)',
      }}
    >
      <div
        className={`flex items-start gap-3 ${canSolve ? 'cursor-pointer' : ''}`}
        dir="rtl"
        onClick={canSolve ? onSolve : undefined}
      >
        <div
          className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl"
          style={{ background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.2)' }}
        >
          <GraduationCap size={18} style={{ color: C.gold }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-semibold text-white leading-tight">{exam.title}</h3>
            <StatusBadge status={exam.extractionStatus} />
          </div>
          <p className="mt-0.5 text-xs text-slate-500">{exam.subject} · {exam.grade}</p>
          <div className="mt-2 flex items-center gap-3 text-xs text-slate-500">
            <span className="flex items-center gap-1">
              <BookOpen size={11} />
              {exam.questionCount ?? 0} سؤال
            </span>
            {exam.year && <span>{exam.year}</span>}
            {exam.examType && <span>{exam.examType}</span>}
          </div>
        </div>
        {canSolve && (
          <ChevronRight size={16} className="text-slate-600 flex-shrink-0 mt-1" />
        )}
      </div>

      {/* Coverage analysis button */}
      {canCoverage && (
        <div className="mt-3 pt-3 border-t border-white/5 flex justify-end" dir="rtl">
          <button
            onClick={(e) => { e.stopPropagation(); onCoverage(); }}
            className="flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-[11px] font-semibold transition-all active:scale-95"
            style={{
              background: 'rgba(0,198,255,0.07)',
              border: '1px solid rgba(0,198,255,0.18)',
              color: '#64a8c8',
            }}
          >
            <BarChart3 size={11} />
            تحليل التغطية
          </button>
        </div>
      )}
    </motion.div>
  );
}

// ─── Mastery bar (shows mastery %, fills as you improve) ──────────────────────
function WeaknessBar({
  topic, score, subject, total,
}: { topic: string; score: number; subject: string; total?: number }) {
  const weaknessPct = Math.round(score * 100);
  const masteryPct  = 100 - weaknessPct;
  const color = masteryPct >= 80 ? C.green : masteryPct >= 50 ? C.gold : C.red;
  const label = masteryPct >= 80 ? 'متقن' : masteryPct >= 50 ? 'جيد' : 'يحتاج مراجعة';
  return (
    <div className="mb-3" dir="rtl">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-xs font-medium text-white truncate">{topic}</span>
          <span className="text-[10px] text-slate-500 flex-shrink-0">{subject}</span>
          {total != null && (
            <span className="text-[9px] text-slate-600 flex-shrink-0">· {total} محاولة</span>
          )}
        </div>
        <span className="text-xs font-bold flex-shrink-0 mr-2" style={{ color }}>
          {label} {masteryPct}%
        </span>
      </div>
      <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${Math.max(2, masteryPct)}%` }}
          transition={{ duration: 0.8, ease: 'easeOut' }}
          className="h-full rounded-full"
          style={{ background: color }}
        />
      </div>
    </div>
  );
}

// ─── Recommended Action Card ──────────────────────────────────────────────────
function RecommendedActionCard({
  label, sub, color, onClick,
}: { label: string; sub: string; color: string; onClick: () => void }) {
  return (
    <motion.button
      whileTap={{ scale: 0.97 }}
      onClick={onClick}
      className="w-full flex items-center gap-3 rounded-2xl p-4 mb-4 text-right"
      dir="rtl"
      style={{
        background: `linear-gradient(135deg, ${color}14, ${color}06)`,
        border: `1px solid ${color}28`,
      }}
    >
      <div
        className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl"
        style={{ background: `${color}18`, border: `1px solid ${color}30` }}
      >
        <Zap size={18} style={{ color }} />
      </div>
      <div className="flex-1 min-w-0 text-right">
        <p className="text-[9px] text-slate-500 mb-0.5">ماذا تدرس الآن؟</p>
        <p className="text-sm font-bold text-white leading-tight">{label}</p>
        <p className="text-[10px] text-slate-400 mt-0.5 leading-tight">{sub}</p>
      </div>
      <ArrowRight size={14} style={{ color }} className="flex-shrink-0 opacity-50" />
    </motion.button>
  );
}

// ─── Progress Overview Card ───────────────────────────────────────────────────
function ProgressOverviewCard({
  masteryPct, latestScore, prevScore, strongestTopic, weakestTopic,
}: {
  masteryPct: number;
  latestScore: number | null;
  prevScore: number | null;
  strongestTopic: string | null;
  weakestTopic: string | null;
}) {
  const trend = (latestScore != null && prevScore != null) ? latestScore - prevScore : null;
  const trendColor = trend == null ? '#64748b' : trend > 1 ? C.green : trend < -1 ? C.red : '#64748b';
  const trendLabel = trend == null ? '' : trend > 1 ? `↑ ${Math.round(trend)}` : trend < -1 ? `↓ ${Math.abs(Math.round(trend))}` : '→ ثابت';
  const masteryColor = masteryPct >= 70 ? C.green : masteryPct >= 45 ? C.gold : C.red;

  return (
    <div
      className="rounded-2xl p-4 mb-4"
      style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)' }}
      dir="rtl"
    >
      <div className="flex items-center gap-2 mb-3">
        <BarChart3 size={12} style={{ color: C.blue }} />
        <span className="text-xs font-bold text-white">نظرة عامة على تقدّمك</span>
      </div>
      <div className="grid grid-cols-2 gap-2 mb-2">
        <div className="rounded-xl p-3" style={{ background: `${masteryColor}08`, border: `1px solid ${masteryColor}18` }}>
          <p className="text-[9px] text-slate-500 mb-1">مستوى الإتقان الكلي</p>
          <p className="text-2xl font-bold leading-none" style={{ color: masteryColor }}>
            {masteryPct}<span className="text-sm font-normal text-slate-500 mr-0.5">%</span>
          </p>
        </div>
        <div className="rounded-xl p-3" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
          <p className="text-[9px] text-slate-500 mb-1">آخر امتحان</p>
          {latestScore != null ? (
            <div className="flex items-end gap-1.5">
              <p className="text-2xl font-bold leading-none text-white">
                {Math.round(latestScore)}<span className="text-sm font-normal text-slate-500 mr-0.5">%</span>
              </p>
              {trendLabel && (
                <span className="text-xs font-bold pb-0.5" style={{ color: trendColor }}>{trendLabel}</span>
              )}
            </div>
          ) : (
            <p className="text-lg text-slate-600 font-bold">—</p>
          )}
        </div>
      </div>
      {(strongestTopic || weakestTopic) && (
        <div className="grid grid-cols-2 gap-2">
          {strongestTopic && (
            <div className="flex items-center gap-1.5 rounded-lg px-2 py-1.5"
              style={{ background: `${C.green}06`, border: `1px solid ${C.green}12` }}>
              <TrendingUp size={11} style={{ color: C.green }} className="flex-shrink-0" />
              <div className="min-w-0">
                <p className="text-[8px] text-slate-600">الأقوى</p>
                <p className="text-[10px] font-semibold text-white truncate">{strongestTopic}</p>
              </div>
            </div>
          )}
          {weakestTopic && (
            <div className="flex items-center gap-1.5 rounded-lg px-2 py-1.5"
              style={{ background: `${C.red}06`, border: `1px solid ${C.red}12` }}>
              <TrendingDown size={11} style={{ color: C.red }} className="flex-shrink-0" />
              <div className="min-w-0">
                <p className="text-[8px] text-slate-600">يحتاج تركيز</p>
                <p className="text-[10px] font-semibold text-white truncate">{weakestTopic}</p>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Question Bank item ───────────────────────────────────────────────────────
function QuestionItem({ q }: { q: ExamQuestion }) {
  const [open, setOpen] = useState(false);
  const diffColor = { easy: C.green, medium: C.gold, hard: C.red }[q.difficulty ?? 'medium'] ?? C.gold;
  const typeLabel: Record<string, string> = {
    mcq: 'اختيار', true_false: 'صح/خطأ', short_answer: 'قصيرة', essay: 'مقالة', calculation: 'حساب',
  };
  return (
    <motion.div
      className="rounded-xl overflow-hidden mb-2"
      style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full text-right p-3"
        dir="rtl"
      >
        <div className="flex items-start gap-2">
          <div className="flex-1 min-w-0">
            <p className="text-xs text-white leading-relaxed line-clamp-2">{q.question}</p>
            <div className="mt-1.5 flex items-center gap-2 flex-wrap">
              {q.difficulty && (
                <span
                  className="text-[9px] font-semibold rounded-full px-2 py-0.5"
                  style={{ color: diffColor, background: `${diffColor}15` }}
                >
                  {q.difficulty === 'easy' ? 'سهل' : q.difficulty === 'medium' ? 'متوسط' : 'صعب'}
                </span>
              )}
              <span className="text-[9px] text-slate-600">{typeLabel[q.questionType] ?? q.questionType}</span>
              {q.topic && <span className="text-[9px] text-slate-600">{q.topic}</span>}
            </div>
          </div>
          <ChevronRight
            size={14}
            className="flex-shrink-0 mt-1 transition-transform text-slate-600"
            style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}
          />
        </div>
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="px-3 pb-3 overflow-hidden"
            dir="rtl"
          >
            {q.options && Array.isArray(q.options) && (
              <div className="mb-2 space-y-1">
                {(q.options as string[]).map((opt, i) => (
                  <div
                    key={i}
                    className="rounded-lg px-3 py-1.5 text-xs"
                    style={{
                      background: q.correctAnswer === opt ? 'rgba(52,211,153,0.1)' : 'rgba(255,255,255,0.03)',
                      border: q.correctAnswer === opt ? '1px solid rgba(52,211,153,0.3)' : '1px solid transparent',
                      color: q.correctAnswer === opt ? C.green : '#94a3b8',
                    }}
                  >
                    {q.correctAnswer === opt && <CheckCircle2 size={10} className="inline ml-1" />}
                    {opt}
                  </div>
                ))}
              </div>
            )}
            {q.correctAnswer && q.questionType !== 'mcq' && (
              <div
                className="rounded-lg px-3 py-2 text-xs mb-2"
                style={{ background: 'rgba(52,211,153,0.08)', border: '1px solid rgba(52,211,153,0.2)', color: C.green }}
              >
                الإجابة: {q.correctAnswer}
              </div>
            )}
            {q.explanation && (
              <p className="text-[11px] text-slate-400 leading-relaxed">{q.explanation}</p>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ─── Main ExamsPage ───────────────────────────────────────────────────────────
export default function ExamsPage() {
  const { setPage, setExamNav, examNav, studentProfile } = useAppStore();

  const [subTab, setSubTab] = useState<SubTab>(examNav.examsSubTab);
  const [exams, setExams]   = useState<ExamRecord[]>([]);
  const [questions, setQuestions] = useState<ExamQuestion[]>([]);
  const [weakTopics, setWeakTopics] = useState<WeakTopicResult[]>([]);
  const [snapshots, setSnapshots]   = useState<WeaknessSnapshot[]>([]);
  const [attempts, setAttempts]     = useState<AttemptWithTitle[]>([]);
  const [weakSubjectFilter, setWeakSubjectFilter] = useState<string>('');
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState('');
  const [coverageExam, setCoverageExam] = useState<{ id: string; title: string } | null>(null);

  // Ref for the extracting-status polling interval
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Bank filters
  const [bankQuery, setBankQuery]     = useState('');
  const [filterDiff, setFilterDiff]   = useState<string>('');
  const [filterType, setFilterType]   = useState<string>('');

  // ── Load data on tab change ──────────────────────────────────────────────────
  const loadExams = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const recs = await listExamRecords();
      setExams(recs);
    } catch { setError('تعذّر تحميل الامتحانات'); }
    finally  { setLoading(false); }
  }, []);

  // Silent refresh — no loading spinner, used by the polling interval
  const silentRefreshExams = useCallback(async () => {
    try {
      const recs = await listExamRecords();
      setExams(recs);
    } catch { /* ignore — next tick will retry */ }
  }, []);

  const loadBank = useCallback(async () => {
    setLoading(true); setError('');
    try {
      // Pass country if available to narrow results; grade/subject are optional
      const qs = await searchBankQuestions({
        country: studentProfile.country || undefined,
      });
      setQuestions(qs);
    } catch { setError('تعذّر تحميل بنك الأسئلة'); }
    finally { setLoading(false); }
  }, [studentProfile.country]);

  const loadWeakness = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [snaps, attData] = await Promise.all([
        listWeaknessSnapshots(),
        listMyAttempts(),
      ]);
      setSnapshots(snaps.snapshots);
      setAttempts(attData.attempts.sort((a, b) =>
        new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
      ));

      // Derive weak topics directly from snapshots (bypasses level↔grade mismatch).
      const derived: WeakTopicResult[] = [];
      for (const snap of snaps.snapshots) {
        for (const [topic, ts] of Object.entries(snap.topicScores)) {
          if (ts.total < 1) continue;
          derived.push({
            subject:       snap.subject,
            topic,
            weaknessScore: 1 - ts.score,
            correct:       ts.correct,
            total:         ts.total,
          });
        }
      }
      derived.sort((a, b) => b.weaknessScore - a.weaknessScore);
      setWeakTopics(derived);
    } catch { setError('تعذّر تحميل تحليل نقاط الضعف'); }
    finally  { setLoading(false); }
  }, []);

  const loadAttempts = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const data = await listMyAttempts();
      setAttempts(data.attempts.sort((a, b) =>
        new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
      ));
    } catch { setError('تعذّر تحميل سجل المحاولات'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    if (subTab === 'my-exams') loadExams();
    else if (subTab === 'bank') loadBank();
    else if (subTab === 'attempts') loadAttempts();
    else loadWeakness();
  }, [subTab]);

  // ── Auto-polling: refresh every 5 s while any exam is still extracting ───────
  useEffect(() => {
    const hasExtracting = exams.some((e) => e.extractionStatus === 'extracting');

    if (hasExtracting && subTab === 'my-exams') {
      if (!pollRef.current) {
        pollRef.current = setInterval(silentRefreshExams, 5_000);
      }
    } else {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    }

    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [exams, subTab, silentRefreshExams]);

  const switchTab = (t: SubTab) => {
    setSubTab(t);
    setExamNav({ examsSubTab: t });
  };

  // ── Navigate to solver ──────────────────────────────────────────────────────
  const goSolve = (examId: string) => {
    setExamNav({ selectedExamId: examId, selectedAttemptId: null });
    setPage('exam-solver');
  };

  // ── Filtered questions ──────────────────────────────────────────────────────
  const filtered = questions.filter((q) => {
    if (filterDiff && q.difficulty !== filterDiff) return false;
    if (filterType && q.questionType !== filterType) return false;
    if (bankQuery) {
      const lq = bankQuery.toLowerCase();
      return (
        q.question.toLowerCase().includes(lq) ||
        (q.topic ?? '').toLowerCase().includes(lq) ||
        (q.chapter ?? '').toLowerCase().includes(lq)
      );
    }
    return true;
  });

  return (
    <PageWrapper>
      {/* ── Header ── */}
      <div
        className="sticky top-0 z-20 px-4 pt-14 pb-4"
        style={{ background: `linear-gradient(180deg, ${C.bg} 80%, transparent)` }}
      >
        <div className="flex items-center justify-between mb-4" dir="rtl">
          <div>
            <h1 className="text-xl font-bold text-white">الامتحانات</h1>
            <p className="text-xs text-slate-500 mt-0.5">حل، تحليل، واستيعاب</p>
          </div>
          <button
            onClick={() => setPage('curriculum-manager')}
            className="flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold"
            style={{ background: 'rgba(0,198,255,0.1)', border: '1px solid rgba(0,198,255,0.2)', color: C.blue }}
          >
            <Plus size={13} />
            رفع
          </button>
        </div>

        {/* Sub-tabs */}
        <div className="flex gap-2 overflow-x-auto pb-0.5 scrollbar-none" dir="rtl">
          <Pill label="امتحاناتي"     active={subTab === 'my-exams'}  onClick={() => switchTab('my-exams')} />
          <Pill label="بنك الأسئلة"   active={subTab === 'bank'}      onClick={() => switchTab('bank')} />
          <Pill label="نقاط الضعف"    active={subTab === 'weakness'}   onClick={() => switchTab('weakness')} />
          <Pill label="سجل المحاولات" active={subTab === 'attempts'}   onClick={() => switchTab('attempts')} />
        </div>
      </div>

      <div className="px-4 pb-4">
        {error && (
          <div className="mb-4 rounded-xl p-3 text-center text-xs" style={{ background: 'rgba(248,113,113,0.1)', color: C.red }}>
            {error}
          </div>
        )}

        {/* ═══════════════ MY EXAMS ═══════════════ */}
        <AnimatePresence mode="wait">
          {subTab === 'my-exams' && (
            <motion.div
              key="my-exams"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              transition={{ duration: 0.2 }}
            >
              {loading ? (
                <div className="space-y-3">
                  {[1,2,3].map((i) => (
                    <div key={i} className="h-20 rounded-2xl animate-pulse" style={{ background: 'rgba(255,255,255,0.04)' }} />
                  ))}
                </div>
              ) : exams.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-center" dir="rtl">
                  <div
                    className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl"
                    style={{ background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.2)' }}
                  >
                    <GraduationCap size={28} style={{ color: C.gold }} />
                  </div>
                  <p className="text-sm font-semibold text-white mb-1">لا توجد امتحانات بعد</p>
                  <p className="text-xs text-slate-500 mb-6">ارفع نماذج امتحانات PDF لبدء التحليل التلقائي</p>
                  <button
                    onClick={() => setPage('curriculum-manager')}
                    className="flex items-center gap-2 rounded-2xl px-5 py-3 text-sm font-bold"
                    style={{ background: 'linear-gradient(135deg, rgba(245,158,11,0.2), rgba(245,158,11,0.1))', border: '1px solid rgba(245,158,11,0.3)', color: C.gold }}
                  >
                    <Plus size={16} />
                    رفع امتحان
                  </button>
                </div>
              ) : (
                <div className="space-y-3">
                  {exams.map((exam) => (
                    <ExamCard
                      key={exam.examId}
                      exam={exam}
                      onSolve={() => goSolve(exam.examId)}
                      onCoverage={() => setCoverageExam({ id: exam.examId, title: exam.title })}
                    />
                  ))}
                </div>
              )}
            </motion.div>
          )}

          {/* ═══════════════ BANK ═══════════════ */}
          {subTab === 'bank' && (
            <motion.div
              key="bank"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              transition={{ duration: 0.2 }}
            >
              {/* Search */}
              <div
                className="flex items-center gap-2 rounded-xl px-3 py-2.5 mb-3"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}
                dir="rtl"
              >
                <Search size={14} className="text-slate-500 flex-shrink-0" />
                <input
                  value={bankQuery}
                  onChange={(e) => setBankQuery(e.target.value)}
                  placeholder="ابحث في الأسئلة..."
                  className="flex-1 bg-transparent text-sm text-white placeholder-slate-600 outline-none text-right"
                />
              </div>

              {/* Filter pills */}
              <div className="flex gap-2 mb-4 flex-wrap" dir="rtl">
                {['', 'easy', 'medium', 'hard'].map((d) => (
                  <button
                    key={d}
                    onClick={() => setFilterDiff(d)}
                    className="rounded-full px-3 py-1 text-[10px] font-semibold transition-all"
                    style={{
                      background: filterDiff === d ? 'rgba(0,198,255,0.15)' : 'rgba(255,255,255,0.04)',
                      border: filterDiff === d ? '1px solid rgba(0,198,255,0.3)' : '1px solid rgba(255,255,255,0.07)',
                      color: filterDiff === d ? C.blue : '#64748b',
                    }}
                  >
                    {d === '' ? 'الكل' : d === 'easy' ? 'سهل' : d === 'medium' ? 'متوسط' : 'صعب'}
                  </button>
                ))}
                <div className="w-px mx-1 self-stretch" style={{ background: 'rgba(255,255,255,0.08)' }} />
                {['', 'mcq', 'true_false', 'short_answer', 'essay'].map((t) => (
                  <button
                    key={t}
                    onClick={() => setFilterType(t)}
                    className="rounded-full px-3 py-1 text-[10px] font-semibold transition-all"
                    style={{
                      background: filterType === t ? 'rgba(245,158,11,0.15)' : 'rgba(255,255,255,0.04)',
                      border: filterType === t ? '1px solid rgba(245,158,11,0.3)' : '1px solid rgba(255,255,255,0.07)',
                      color: filterType === t ? C.gold : '#64748b',
                    }}
                  >
                    {t === '' ? 'الكل' : t === 'mcq' ? 'اختيار' : t === 'true_false' ? 'صح/خطأ' : t === 'short_answer' ? 'قصيرة' : 'مقالة'}
                  </button>
                ))}
              </div>

              {loading ? (
                <div className="space-y-2">
                  {[1,2,3,4].map((i) => <div key={i} className="h-16 rounded-xl animate-pulse" style={{ background: 'rgba(255,255,255,0.04)' }} />)}
                </div>
              ) : filtered.length === 0 ? (
                <div className="py-12 text-center" dir="rtl">
                  <FileText size={32} className="mx-auto mb-3 text-slate-700" />
                  <p className="text-sm text-slate-500">
                    {questions.length === 0 ? 'لا توجد أسئلة — ارفع امتحاناتك أولاً' : 'لا توجد نتائج للفلتر المحدد'}
                  </p>
                </div>
              ) : (
                <div>
                  <p className="text-xs text-slate-600 mb-3 text-right">{filtered.length} سؤال</p>
                  {filtered.map((q) => <QuestionItem key={q.id} q={q} />)}
                </div>
              )}
            </motion.div>
          )}

          {/* ═══════════════ WEAKNESS DASHBOARD / MASTERY MAP ═══════════════ */}
          {subTab === 'weakness' && (() => {
            const subjects = [...new Set(weakTopics.map(t => t.subject))];
            const vis = weakSubjectFilter ? weakTopics.filter(t => t.subject === weakSubjectFilter) : weakTopics;
            const veryWeak = vis.filter(t => t.weaknessScore > 0.5);
            const medium   = vis.filter(t => t.weaknessScore > 0.2 && t.weaknessScore <= 0.5);
            const strong   = vis.filter(t => t.weaknessScore <= 0.2);

            // ── Analytics computed from existing data only ───────────────────
            const totalAnswered = weakTopics.reduce((s, t) => s + t.total, 0);
            const totalCorrect  = weakTopics.reduce((s, t) => s + t.correct, 0);
            const overallMastery = totalAnswered > 0
              ? Math.round((totalCorrect / totalAnswered) * 100) : 0;

            const sortedByStrength = [...weakTopics].sort((a, b) => a.weaknessScore - b.weaknessScore);
            const strongestTopic = sortedByStrength[0]?.topic ?? null;
            const weakestTopic   = sortedByStrength[sortedByStrength.length - 1]?.topic ?? null;

            const completedAttempts = attempts
              .filter(a => a.status === 'completed' && a.scorePct != null)
              .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
            const latestScore = completedAttempts[0]
              ? parseFloat(String(completedAttempts[0].scorePct)) : null;
            const prevScore   = completedAttempts[1]
              ? parseFloat(String(completedAttempts[1].scorePct)) : null;

            // ── Recommended Action ───────────────────────────────────────────
            const worstTopic = weakTopics[0];
            let recLabel: string, recSub: string, recColor: string, recAction: () => void;
            if (worstTopic && worstTopic.weaknessScore > 0.5) {
              recLabel  = `راجع "${worstTopic.topic}"`;
              recSub    = `إتقانك ${Math.round((1 - worstTopic.weaknessScore) * 100)}% فقط في مادة ${worstTopic.subject}`;
              recColor  = C.red;
              recAction = () => { setExamNav({ generatorSubject: worstTopic.subject, generatorTopic: worstTopic.topic }); setPage('exam-generator'); };
            } else if (worstTopic) {
              recLabel  = `أنشئ امتحاناً تدريبياً لتقوية مستواك`;
              recSub    = `ركّز على: ${worstTopic.topic} في ${worstTopic.subject}`;
              recColor  = C.blue;
              recAction = () => { setExamNav({ generatorSubject: worstTopic.subject, generatorTopic: worstTopic.topic }); setPage('exam-generator'); };
            } else {
              recLabel  = 'حل امتحانك الأول لبدء تتبع تقدّمك';
              recSub    = 'سيتم تحليل نتائجك تلقائياً بعد الإرسال';
              recColor  = C.gold;
              recAction = () => switchTab('my-exams');
            }

            return (
              <motion.div
                key="weakness"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                transition={{ duration: 0.2 }}
              >
                {loading ? (
                  <div className="space-y-3">
                    {[1,2,3].map((i) => <div key={i} className="h-24 rounded-2xl animate-pulse" style={{ background: 'rgba(255,255,255,0.04)' }} />)}
                  </div>
                ) : weakTopics.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-16 text-center" dir="rtl">
                    <div
                      className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl"
                      style={{ background: 'rgba(0,198,255,0.1)', border: '1px solid rgba(0,198,255,0.2)' }}
                    >
                      <BarChart3 size={28} style={{ color: C.blue }} />
                    </div>
                    <p className="text-sm font-semibold text-white mb-1">لا يوجد تحليل بعد</p>
                    <p className="text-xs text-slate-500 mb-4">
                      حل امتحانًا وأرسله لبدء تحليل نقاط قوتك وضعفك
                    </p>
                    <button
                      onClick={() => switchTab('my-exams')}
                      className="flex items-center gap-2 rounded-xl px-4 py-2.5 text-xs font-bold"
                      style={{ background: 'rgba(0,198,255,0.1)', border: '1px solid rgba(0,198,255,0.2)', color: C.blue }}
                    >
                      <ArrowRight size={14} />
                      ابدأ بحل امتحان
                    </button>
                  </div>
                ) : (
                  <div>
                    {/* ── Recommended Action Card ── */}
                    <RecommendedActionCard
                      label={recLabel}
                      sub={recSub}
                      color={recColor}
                      onClick={recAction}
                    />

                    {/* ── Summary stats ── */}
                    <div className="grid grid-cols-3 gap-2 mb-4">
                      {[
                        { label: 'مستوى الإتقان',  value: `${overallMastery}%`,                                  icon: <Trophy size={13} />,       color: overallMastery >= 70 ? C.green : overallMastery >= 45 ? C.gold : C.red },
                        { label: 'تحتاج مراجعة',   value: weakTopics.filter(t => t.weaknessScore > 0.5).length,  icon: <TrendingDown size={13} />, color: C.red   },
                        { label: 'نقاط قوة',        value: weakTopics.filter(t => t.weaknessScore <= 0.2).length, icon: <TrendingUp size={13} />,   color: C.green },
                      ].map((s) => (
                        <div
                          key={s.label}
                          className="flex flex-col items-center rounded-xl py-3"
                          style={{ background: `${s.color}08`, border: `1px solid ${s.color}18` }}
                        >
                          <span style={{ color: s.color }}>{s.icon}</span>
                          <span className="text-lg font-bold text-white mt-1">{s.value}</span>
                          <span className="text-[9px] text-slate-600 text-center leading-tight mt-0.5">{s.label}</span>
                        </div>
                      ))}
                    </div>

                    {/* ── Progress Overview Card ── */}
                    <ProgressOverviewCard
                      masteryPct={overallMastery}
                      latestScore={latestScore}
                      prevScore={prevScore}
                      strongestTopic={strongestTopic}
                      weakestTopic={weakestTopic}
                    />

                    {/* ── Generate Remedial Exam CTA ── */}
                    <button
                      onClick={() => {
                        setExamNav({ generatorSubject: veryWeak[0]?.subject ?? weakTopics[0]?.subject ?? '', generatorTopic: veryWeak[0]?.topic });
                        setPage('exam-generator');
                      }}
                      className="w-full flex items-center justify-center gap-2 rounded-2xl py-3 mb-4 text-sm font-bold transition-all active:scale-95"
                      style={{
                        background: 'linear-gradient(135deg, rgba(0,198,255,0.15), rgba(0,144,255,0.1))',
                        border: '1px solid rgba(0,198,255,0.25)',
                        color: C.blue,
                      }}
                    >
                      <Zap size={15} />
                      أنشئ امتحان تدريبي من نقاط الضعف
                    </button>

                    {/* Subject filter */}
                    {subjects.length > 1 && (
                      <div className="flex gap-2 mb-4 overflow-x-auto pb-0.5 scrollbar-none" dir="rtl">
                        <button
                          onClick={() => setWeakSubjectFilter('')}
                          className="flex-shrink-0 rounded-full px-3 py-1 text-[10px] font-semibold"
                          style={{
                            background: weakSubjectFilter === '' ? 'rgba(0,198,255,0.15)' : 'rgba(255,255,255,0.04)',
                            border: weakSubjectFilter === '' ? '1px solid rgba(0,198,255,0.3)' : '1px solid rgba(255,255,255,0.07)',
                            color: weakSubjectFilter === '' ? C.blue : '#64748b',
                          }}
                        >الكل</button>
                        {subjects.map(s => (
                          <button
                            key={s}
                            onClick={() => setWeakSubjectFilter(s)}
                            className="flex-shrink-0 rounded-full px-3 py-1 text-[10px] font-semibold"
                            style={{
                              background: weakSubjectFilter === s ? 'rgba(0,198,255,0.15)' : 'rgba(255,255,255,0.04)',
                              border: weakSubjectFilter === s ? '1px solid rgba(0,198,255,0.3)' : '1px solid rgba(255,255,255,0.07)',
                              color: weakSubjectFilter === s ? C.blue : '#64748b',
                            }}
                          >{s}</button>
                        ))}
                      </div>
                    )}

                    {/* Weak topics */}
                    {veryWeak.length > 0 && (
                      <div className="rounded-2xl p-4 mb-3" style={{ background: 'rgba(248,113,113,0.04)', border: '1px solid rgba(248,113,113,0.12)' }}>
                        <div className="flex items-center gap-2 mb-3" dir="rtl">
                          <TrendingDown size={14} style={{ color: C.red }} />
                          <h3 className="text-sm font-bold" style={{ color: C.red }}>تحتاج مراجعة</h3>
                          <span className="text-[10px] text-slate-600">({veryWeak.length})</span>
                        </div>
                        {veryWeak.map(t => <WeaknessBar key={`${t.subject}-${t.topic}`} topic={t.topic} score={t.weaknessScore} subject={t.subject} total={t.total} />)}
                      </div>
                    )}

                    {/* Medium topics */}
                    {medium.length > 0 && (
                      <div className="rounded-2xl p-4 mb-3" style={{ background: 'rgba(245,158,11,0.04)', border: '1px solid rgba(245,158,11,0.12)' }}>
                        <div className="flex items-center gap-2 mb-3" dir="rtl">
                          <LayoutGrid size={14} style={{ color: C.gold }} />
                          <h3 className="text-sm font-bold" style={{ color: C.gold }}>يمكن التحسين</h3>
                          <span className="text-[10px] text-slate-600">({medium.length})</span>
                        </div>
                        {medium.map(t => <WeaknessBar key={`${t.subject}-${t.topic}`} topic={t.topic} score={t.weaknessScore} subject={t.subject} total={t.total} />)}
                      </div>
                    )}

                    {/* Strong topics (Mastered) */}
                    {strong.length > 0 && (
                      <div className="rounded-2xl p-4" style={{ background: 'rgba(52,211,153,0.04)', border: '1px solid rgba(52,211,153,0.12)' }}>
                        <div className="flex items-center gap-2 mb-3" dir="rtl">
                          <TrendingUp size={14} style={{ color: C.green }} />
                          <h3 className="text-sm font-bold" style={{ color: C.green }}>مُتقَن ✓</h3>
                          <span className="text-[10px] text-slate-600">({strong.length})</span>
                        </div>
                        {strong.map(t => <WeaknessBar key={`${t.subject}-${t.topic}`} topic={t.topic} score={t.weaknessScore} subject={t.subject} total={t.total} />)}
                      </div>
                    )}
                  </div>
                )}
              </motion.div>
            );
          })()}

          {/* ═══════════════ ATTEMPTS HISTORY ═══════════════ */}
          {subTab === 'attempts' && (
            <motion.div
              key="attempts"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              transition={{ duration: 0.2 }}
            >
              {loading ? (
                <div className="space-y-3">
                  {[1,2,3,4].map((i) => <div key={i} className="h-20 rounded-2xl animate-pulse" style={{ background: 'rgba(255,255,255,0.04)' }} />)}
                </div>
              ) : attempts.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-center" dir="rtl">
                  <div
                    className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl"
                    style={{ background: 'rgba(0,198,255,0.08)', border: '1px solid rgba(0,198,255,0.2)' }}
                  >
                    <Clock size={28} style={{ color: C.blue }} />
                  </div>
                  <p className="text-sm font-semibold text-white mb-1">لا توجد محاولات بعد</p>
                  <p className="text-xs text-slate-500 mb-4">حل امتحانًا لتظهر هنا محاولاتك وتقدّمك</p>
                  <button
                    onClick={() => switchTab('my-exams')}
                    className="flex items-center gap-2 rounded-xl px-4 py-2.5 text-xs font-bold"
                    style={{ background: 'rgba(0,198,255,0.1)', border: '1px solid rgba(0,198,255,0.2)', color: C.blue }}
                  >
                    <ArrowRight size={14} />
                    ابدأ بحل امتحان
                  </button>
                </div>
              ) : (
                <div className="space-y-3">
                  {/* ── Score Trend Card ── */}
                  {(() => {
                    const done = [...attempts]
                      .filter(a => a.status === 'completed' && a.scorePct != null)
                      .sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime());
                    if (done.length < 2) return null;
                    const last5 = done.slice(-5);
                    const avg = Math.round(done.reduce((s, a) => s + parseFloat(String(a.scorePct)), 0) / done.length);
                    const latest = parseFloat(String(done[done.length - 1].scorePct));
                    const prev   = parseFloat(String(done[done.length - 2].scorePct));
                    const diff   = Math.round(latest - prev);
                    const diffColor = diff > 0 ? C.green : diff < 0 ? C.red : '#64748b';
                    const diffLabel = diff > 0 ? `↑ ${diff}` : diff < 0 ? `↓ ${Math.abs(diff)}` : '→ ثابت';
                    return (
                      <div className="rounded-2xl p-4 mb-1"
                        style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)' }}
                        dir="rtl"
                      >
                        <div className="flex items-center justify-between mb-3">
                          <span className="text-xs font-bold text-white">مسار درجاتك</span>
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] text-slate-500">
                              متوسط: <span className="font-bold text-white">{avg}%</span>
                            </span>
                            <span className="text-[10px] font-bold" style={{ color: diffColor }}>{diffLabel}</span>
                          </div>
                        </div>
                        <div className="flex items-end gap-1.5 h-14" dir="ltr">
                          {last5.map((a) => {
                            const s = parseFloat(String(a.scorePct));
                            const col = s >= 70 ? C.green : s >= 50 ? C.gold : C.red;
                            const h = Math.max(12, Math.round(s * 0.9));
                            return (
                              <div key={a.id} className="flex flex-col items-center gap-1 flex-1">
                                <span className="text-[8px] font-bold" style={{ color: col }}>{Math.round(s)}</span>
                                <div
                                  className="w-full rounded-t-md transition-all"
                                  style={{ height: `${h}%`, background: `${col}55`, border: `1px solid ${col}40` }}
                                />
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })()}

                  <p className="text-xs text-slate-600 text-right mb-1">{attempts.length} محاولة</p>
                  {attempts.map((a) => {
                    const scorePct = a.scorePct != null ? parseFloat(String(a.scorePct)) : null;
                    const scoreColor = scorePct == null ? '#64748b' : scorePct >= 70 ? C.green : scorePct >= 50 ? C.gold : C.red;
                    const isCompleted = a.status === 'completed';
                    const date = new Date(a.startedAt);
                    const dateStr = date.toLocaleDateString('ar-EG', { day: 'numeric', month: 'short' });
                    let duration = '';
                    if (a.completedAt) {
                      const mins = Math.round((new Date(a.completedAt).getTime() - date.getTime()) / 60000);
                      if (mins > 0) duration = `${mins} دقيقة`;
                    }
                    return (
                      <motion.div
                        key={a.id}
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        whileTap={isCompleted ? { scale: 0.98 } : undefined}
                        onClick={isCompleted ? () => {
                          setExamNav({ selectedAttemptId: a.id, selectedExamId: a.examId });
                          setPage('exam-results');
                        } : undefined}
                        className={`rounded-2xl p-4 ${isCompleted ? 'cursor-pointer' : 'opacity-70'}`}
                        style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}
                      >
                        <div className="flex items-center gap-3" dir="rtl">
                          <div
                            className="flex h-12 w-12 flex-shrink-0 flex-col items-center justify-center rounded-xl"
                            style={{ background: `${scoreColor}12`, border: `1px solid ${scoreColor}25` }}
                          >
                            {scorePct != null ? (
                              <>
                                <span className="text-sm font-bold leading-none" style={{ color: scoreColor }}>{Math.round(scorePct)}</span>
                                <span className="text-[9px] text-slate-600">%</span>
                              </>
                            ) : (
                              <Clock size={16} className="text-slate-600" />
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-semibold text-white leading-tight truncate">{a.examTitle}</p>
                            <div className="mt-1 flex items-center gap-2 flex-wrap">
                              <span className="text-[10px] text-slate-500">{dateStr}</span>
                              {duration && <span className="text-[10px] text-slate-600">· {duration}</span>}
                              <span
                                className="text-[9px] font-semibold rounded-full px-2 py-0.5"
                                style={{
                                  color: isCompleted ? C.green : C.gold,
                                  background: isCompleted ? 'rgba(52,211,153,0.1)' : 'rgba(245,158,11,0.1)',
                                }}
                              >
                                {isCompleted ? 'مكتمل' : 'جارٍ'}
                              </span>
                            </div>
                            {isCompleted && a.totalQuestions > 0 && (
                              <p className="text-[10px] text-slate-600 mt-0.5">
                                {a.correctCount} / {a.totalQuestions} إجابة صحيحة
                              </p>
                            )}
                          </div>
                          {isCompleted && <Trophy size={14} className="text-slate-600 flex-shrink-0" />}
                        </div>
                      </motion.div>
                    );
                  })}
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* ── Coverage Analysis Modal ── */}
      <AnimatePresence>
        {coverageExam && (
          <ExamCoverageModal
            examId={coverageExam.id}
            examTitle={coverageExam.title}
            onClose={() => setCoverageExam(null)}
          />
        )}
      </AnimatePresence>
    </PageWrapper>
  );
}
