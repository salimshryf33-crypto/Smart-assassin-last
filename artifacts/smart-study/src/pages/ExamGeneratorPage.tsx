import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowLeft, Zap, GraduationCap, BookOpen, Hash,
  ChevronDown, CheckCircle2, Loader2, AlertCircle,
} from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { generateExam, listWeaknessSnapshots } from '../utils/curriculumApi';

const C = {
  blue:  '#00c6ff',
  gold:  '#f59e0b',
  green: '#34d399',
  red:   '#f87171',
  bg:    '#0a0f1e',
};

// ─── Field wrapper ────────────────────────────────────────────────────────────
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-4" dir="rtl">
      <label className="text-xs font-semibold text-slate-400 mb-1.5 block">{label}</label>
      {children}
    </div>
  );
}

// ─── Select ───────────────────────────────────────────────────────────────────
function Select({
  value, onChange, options, placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  placeholder?: string;
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full appearance-none rounded-xl px-4 py-3 pr-10 text-sm text-white outline-none"
        style={{
          background: 'rgba(255,255,255,0.05)',
          border: '1px solid rgba(255,255,255,0.1)',
          direction: 'rtl',
        }}
      >
        {placeholder && <option value="">{placeholder}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value} style={{ background: '#0a1628' }}>{o.label}</option>
        ))}
      </select>
      <ChevronDown size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
    </div>
  );
}

// ─── TextInput ────────────────────────────────────────────────────────────────
function TextInput({
  value, onChange, placeholder,
}: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      dir="rtl"
      className="w-full rounded-xl px-4 py-3 text-sm text-white placeholder-slate-600 outline-none"
      style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}
    />
  );
}

// ─── CountPicker ─────────────────────────────────────────────────────────────
function CountPicker({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const opts = [5, 10, 15, 20, 25, 30];
  return (
    <div className="flex gap-2 flex-wrap" dir="rtl">
      {opts.map((n) => (
        <button
          key={n}
          onClick={() => onChange(n)}
          className="w-12 h-10 rounded-xl text-sm font-bold transition-all"
          style={{
            background: value === n ? 'rgba(0,198,255,0.15)' : 'rgba(255,255,255,0.04)',
            border: value === n ? '1px solid rgba(0,198,255,0.35)' : '1px solid rgba(255,255,255,0.08)',
            color: value === n ? C.blue : '#64748b',
          }}
        >
          {n}
        </button>
      ))}
    </div>
  );
}

// ─── DifficultyPicker ─────────────────────────────────────────────────────────
type DifficultyPreset = 'balanced' | 'easy-focus' | 'hard-focus' | 'mcq-only';
const DIFFICULTY_PRESETS: { id: DifficultyPreset; label: string; sub: string; breakdown: Record<string, number> }[] = [
  { id: 'balanced',   label: 'متوازن',       sub: 'سهل + متوسط + صعب', breakdown: { mcq: 40, short_answer: 30, true_false: 20, essay: 10 } },
  { id: 'easy-focus', label: 'مراجعة سريعة', sub: 'اختيار من متعدد',    breakdown: { mcq: 60, true_false: 30, short_answer: 10 } },
  { id: 'hard-focus', label: 'تحدّي',        sub: 'أسئلة صعبة ومقالية',  breakdown: { essay: 40, short_answer: 35, mcq: 25 } },
  { id: 'mcq-only',   label: 'اختيار فقط',   sub: '100% اختيار من متعدد', breakdown: { mcq: 100 } },
];

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function ExamGeneratorPage() {
  const { setPage, setExamNav, examNav, studentProfile } = useAppStore();

  // Pre-fill from weakness dashboard navigation
  const [subject, setSubject] = useState(examNav.generatorSubject ?? '');
  const [chapter, setChapter] = useState('');
  const [topic, setTopic]     = useState(examNav.generatorTopic ?? '');
  const [count, setCount]     = useState(10);
  const [preset, setPreset]   = useState<DifficultyPreset>('balanced');
  const [title, setTitle]     = useState('');

  const [subjects, setSubjects] = useState<string[]>([]);
  const [generating, setGenerating] = useState(false);
  const [error, setError]           = useState('');
  const [done, setDone]             = useState<{ examId: string; questionCount: number; title: string } | null>(null);

  // Load available subjects from weakness snapshots (subjects the student has data for)
  useEffect(() => {
    listWeaknessSnapshots().then((data) => {
      const subs = [...new Set(data.snapshots.map(s => s.subject))].filter(Boolean);
      setSubjects(subs);
    }).catch(() => {});
  }, []);

  const canGenerate = !!subject.trim() && !generating;

  const handleGenerate = async () => {
    if (!canGenerate) return;
    setGenerating(true);
    setError('');
    try {
      const chosenPreset = DIFFICULTY_PRESETS.find(p => p.id === preset)!;
      const result = await generateExam({
        country:       studentProfile.country || 'egypt',
        grade:         studentProfile.level   || 'secondary',
        subject:       subject.trim(),
        track:         studentProfile.track   || undefined,
        chapter:       chapter.trim()         || undefined,
        topic:         topic.trim()           || undefined,
        count,
        title:         title.trim()           || undefined,
        typeBreakdown: chosenPreset.breakdown,
      });
      setDone(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'فشل توليد الامتحان');
    } finally {
      setGenerating(false);
    }
  };

  const handleStartExam = () => {
    if (!done) return;
    setExamNav({ selectedExamId: done.examId, selectedAttemptId: null, generatorSubject: undefined, generatorTopic: undefined });
    setPage('exam-solver');
  };

  const handleBack = () => {
    setExamNav({ generatorSubject: undefined, generatorTopic: undefined });
    setPage('exams');
  };

  const subjectOptions = subjects.map(s => ({ value: s, label: s }));

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -16 }}
      transition={{ duration: 0.25 }}
      className="min-h-screen overflow-y-auto pb-8"
      style={{ background: 'linear-gradient(135deg, #060b18 0%, #0a1628 100%)' }}
    >
      {/* Header */}
      <div
        className="sticky top-0 z-10 flex items-center gap-3 px-4 pt-14 pb-4"
        style={{ background: 'linear-gradient(180deg, #060b18 80%, transparent)' }}
        dir="rtl"
      >
        <button
          onClick={handleBack}
          className="flex h-9 w-9 items-center justify-center rounded-xl"
          style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)' }}
        >
          <ArrowLeft size={16} className="text-slate-400 rotate-180" />
        </button>
        <div>
          <h1 className="text-lg font-bold text-white">مولّد الامتحانات</h1>
          <p className="text-xs text-slate-500 mt-0.5">امتحان تدريبي مُولَّد بالذكاء الاصطناعي</p>
        </div>
        <div
          className="mr-auto flex h-9 w-9 items-center justify-center rounded-xl"
          style={{ background: 'rgba(0,198,255,0.1)', border: '1px solid rgba(0,198,255,0.2)' }}
        >
          <Zap size={16} style={{ color: C.blue }} />
        </div>
      </div>

      <div className="px-4">
        <AnimatePresence mode="wait">
          {/* ── Success state ── */}
          {done ? (
            <motion.div
              key="done"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="flex flex-col items-center justify-center py-16 text-center"
              dir="rtl"
            >
              <div
                className="mb-5 flex h-20 w-20 items-center justify-center rounded-3xl"
                style={{ background: 'rgba(52,211,153,0.12)', border: '1px solid rgba(52,211,153,0.25)' }}
              >
                <CheckCircle2 size={36} style={{ color: C.green }} />
              </div>
              <h2 className="text-xl font-bold text-white mb-1">تم إنشاء الامتحان!</h2>
              <p className="text-sm text-slate-400 mb-1">{done.title}</p>
              <p className="text-xs text-slate-600 mb-8">
                {done.questionCount} سؤال · جاهز للحل الآن
              </p>
              <button
                onClick={handleStartExam}
                className="w-full rounded-2xl py-4 text-base font-bold mb-3 transition-all active:scale-95"
                style={{
                  background: 'linear-gradient(135deg, rgba(0,198,255,0.2), rgba(0,144,255,0.15))',
                  border: '1px solid rgba(0,198,255,0.3)',
                  color: C.blue,
                  boxShadow: '0 0 30px rgba(0,198,255,0.1)',
                }}
              >
                ابدأ الامتحان الآن
              </button>
              <button
                onClick={handleBack}
                className="text-sm text-slate-500"
              >
                العودة للامتحانات
              </button>
            </motion.div>
          ) : (
            /* ── Form state ── */
            <motion.div key="form">
              {/* Subject */}
              <Field label="المادة *">
                {subjects.length > 0 ? (
                  <Select
                    value={subject}
                    onChange={setSubject}
                    options={subjectOptions}
                    placeholder="اختر المادة..."
                  />
                ) : (
                  <TextInput
                    value={subject}
                    onChange={setSubject}
                    placeholder="مثال: أحياء، فيزياء، كيمياء..."
                  />
                )}
              </Field>

              {/* Chapter */}
              <Field label="الفصل أو الوحدة (اختياري)">
                <TextInput
                  value={chapter}
                  onChange={setChapter}
                  placeholder="مثال: الفصل الثالث، الوحدة الثانية..."
                />
              </Field>

              {/* Topic */}
              <Field label="الموضوع المحدد (اختياري)">
                <TextInput
                  value={topic}
                  onChange={setTopic}
                  placeholder="مثال: الانعكاس، التكاثر اللاجنسي..."
                />
              </Field>

              {/* Count */}
              <Field label="عدد الأسئلة">
                <CountPicker value={count} onChange={setCount} />
              </Field>

              {/* Difficulty preset */}
              <Field label="نوع الامتحان">
                <div className="space-y-2">
                  {DIFFICULTY_PRESETS.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => setPreset(p.id)}
                      className="w-full flex items-center gap-3 rounded-xl px-4 py-3 transition-all"
                      style={{
                        background: preset === p.id ? 'rgba(0,198,255,0.08)' : 'rgba(255,255,255,0.03)',
                        border: preset === p.id ? '1px solid rgba(0,198,255,0.25)' : '1px solid rgba(255,255,255,0.07)',
                      }}
                      dir="rtl"
                    >
                      <div
                        className="h-4 w-4 rounded-full flex-shrink-0 flex items-center justify-center"
                        style={{
                          border: `2px solid ${preset === p.id ? C.blue : '#334155'}`,
                          background: preset === p.id ? C.blue : 'transparent',
                        }}
                      >
                        {preset === p.id && <div className="h-1.5 w-1.5 rounded-full bg-white" />}
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-semibold" style={{ color: preset === p.id ? C.blue : '#e2e8f0' }}>{p.label}</p>
                        <p className="text-[11px] text-slate-500">{p.sub}</p>
                      </div>
                    </button>
                  ))}
                </div>
              </Field>

              {/* Custom title */}
              <Field label="عنوان مخصص (اختياري)">
                <TextInput
                  value={title}
                  onChange={setTitle}
                  placeholder="مثال: مراجعة نهائي الترم الأول..."
                />
              </Field>

              {/* Error */}
              {error && (
                <div
                  className="mb-4 flex items-center gap-2 rounded-xl p-3 text-xs"
                  style={{ background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.2)', color: C.red }}
                  dir="rtl"
                >
                  <AlertCircle size={14} className="flex-shrink-0" />
                  {error}
                </div>
              )}

              {/* Info box */}
              <div
                className="mb-6 rounded-xl p-3 text-xs"
                style={{ background: 'rgba(0,198,255,0.05)', border: '1px solid rgba(0,198,255,0.1)' }}
                dir="rtl"
              >
                <div className="flex items-start gap-2">
                  <BookOpen size={12} className="mt-0.5 flex-shrink-0" style={{ color: C.blue }} />
                  <p className="text-slate-400 leading-relaxed">
                    سيولّد الذكاء الاصطناعي امتحانًا من محتوى مناهجك المرفوعة.
                    {' '}<span style={{ color: C.blue }}>المادة إلزامية</span>، وباقي الحقول اختيارية لتخصيص الامتحان.
                  </p>
                </div>
              </div>

              {/* Generate button */}
              <button
                onClick={handleGenerate}
                disabled={!canGenerate}
                className="w-full rounded-2xl py-4 text-base font-bold transition-all active:scale-95 flex items-center justify-center gap-2"
                style={{
                  background: canGenerate
                    ? 'linear-gradient(135deg, rgba(0,198,255,0.2), rgba(0,144,255,0.15))'
                    : 'rgba(255,255,255,0.04)',
                  border: canGenerate
                    ? '1px solid rgba(0,198,255,0.35)'
                    : '1px solid rgba(255,255,255,0.08)',
                  color: canGenerate ? C.blue : '#334155',
                  boxShadow: canGenerate ? '0 0 30px rgba(0,198,255,0.1)' : 'none',
                  opacity: canGenerate ? 1 : 0.6,
                }}
              >
                {generating ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    جاري التوليد...
                  </>
                ) : (
                  <>
                    <Zap size={16} />
                    ولّد الامتحان
                  </>
                )}
              </button>

              {generating && (
                <motion.p
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="text-center text-xs text-slate-500 mt-3"
                  dir="rtl"
                >
                  يحتاج التوليد 15–30 ثانية — الذكاء الاصطناعي يقرأ مناهجك ويصيغ الأسئلة...
                </motion.p>
              )}

              {/* Student profile info */}
              {(studentProfile.country || studentProfile.level) && (
                <div className="mt-4 flex items-center gap-2 justify-center" dir="rtl">
                  <GraduationCap size={11} className="text-slate-700" />
                  <span className="text-[10px] text-slate-700">
                    {studentProfile.country === 'egypt' ? 'مصر' : studentProfile.country === 'sudan' ? 'السودان' : ''}
                    {' · '}
                    {studentProfile.level === 'secondary' ? 'ثانوي' : studentProfile.level === 'preparatory' ? 'إعدادي' : studentProfile.level === 'primary' ? 'ابتدائي' : ''}
                    {studentProfile.track ? ` · ${studentProfile.track === 'scientific' ? 'علمي' : 'أدبي'}` : ''}
                  </span>
                  <Hash size={11} className="text-slate-700" />
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}
