import { useState, useRef, useCallback, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Upload, Trash2, BookOpen, CheckCircle2, AlertCircle,
  Loader2, ChevronLeft, Database, FileText, Clock,
} from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import {
  uploadCurriculumPdf,
  getJobStatus,
  getCurriculumDocs,
  deleteCurriculumDoc,
  type CurriculumDocMeta,
  type JobStatus,
} from '../utils/curriculumApi';
import type { } from '../utils/curriculumStore';
import { GRADE_OPTIONS } from '../data/curriculum/types';
import { getSubjects } from '../utils/curriculum';

const COUNTRY_OPTIONS = [
  { value: 'egypt', label: '🇪🇬 مصر' },
  { value: 'sudan', label: '🇸🇩 السودان' },
];

const LEVEL_LABELS: Record<string, string> = {
  primary: 'الابتدائية',
  preparatory: 'الإعدادية',
  secondary: 'الثانوية',
};

type UploadState =
  | { phase: 'idle' }
  | { phase: 'uploading' }
  | { phase: 'processing'; jobId: string; progress: { current: number; total: number } }
  | { phase: 'done'; result: { totalPages: number; chunkCount: number } }
  | { phase: 'error'; message: string };

export default function CurriculumManager() {
  const setPage = useAppStore((s) => s.setPage);

  const [docs, setDocs] = useState<CurriculumDocMeta[]>([]);
  const [loadingDocs, setLoadingDocs] = useState(true);

  const [country, setCountry] = useState('');
  const [grade, setGrade] = useState('');
  const [subject, setSubject] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [uploadState, setUploadState] = useState<UploadState>({ phase: 'idle' });

  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const selectedGradeOption = GRADE_OPTIONS.find((g) => g.value === grade);
  const levelForGrade = selectedGradeOption?.level ?? '';
  const availableSubjects = getSubjects(
    country as 'egypt' | 'sudan' | '',
    levelForGrade as 'primary' | 'preparatory' | 'secondary' | '',
    ''
  );

  const refreshDocs = useCallback(async () => {
    try {
      const data = await getCurriculumDocs();
      setDocs(data);
    } catch { /* ignore */ } finally {
      setLoadingDocs(false);
    }
  }, []);

  useEffect(() => { refreshDocs(); }, [refreshDocs]);

  const stopPolling = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  };

  const startPolling = (jobId: string) => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const status: JobStatus = await getJobStatus(jobId);
        if (status.status === 'processing' || status.status === 'queued') {
          setUploadState({ phase: 'processing', jobId, progress: status.progress });
        } else if (status.status === 'done' && status.result) {
          stopPolling();
          setUploadState({ phase: 'done', result: status.result });
          await refreshDocs();
          setFile(null);
          setGrade('');
          setSubject('');
          if (fileInputRef.current) fileInputRef.current.value = '';
        } else if (status.status === 'error') {
          stopPolling();
          setUploadState({ phase: 'error', message: status.error ?? 'فشل في المعالجة' });
          await refreshDocs();
        }
      } catch { /* ignore */ }
    }, 1500);
  };

  useEffect(() => () => stopPolling(), []);

  const handleFileDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const dropped = e.dataTransfer.files[0];
    if (dropped?.type === 'application/pdf') setFile(dropped);
  }, []);

  const handleUpload = async () => {
    if (!country || !grade || !subject || !file) return;
    setUploadState({ phase: 'uploading' });
    try {
      const { jobId } = await uploadCurriculumPdf(file, { country, grade, subject });
      setUploadState({ phase: 'processing', jobId, progress: { current: 0, total: 0 } });
      startPolling(jobId);
    } catch (err) {
      setUploadState({ phase: 'error', message: err instanceof Error ? err.message : 'فشل الرفع' });
    }
  };

  const handleDelete = async (id: string) => {
    await deleteCurriculumDoc(id);
    await refreshDocs();
  };

  const gradeLabel = (g: string) => GRADE_OPTIONS.find((o) => o.value === g)?.label ?? g;

  const subjectLabel = (country: string, grade: string, subjectId: string) => {
    const level = GRADE_OPTIONS.find((g) => g.value === grade)?.level ?? '';
    return getSubjects(
      country as 'egypt' | 'sudan' | '',
      level as 'primary' | 'preparatory' | 'secondary' | '',
      ''
    ).find((s) => s.id === subjectId)?.label ?? subjectId;
  };

  const isUploading = uploadState.phase === 'uploading' || uploadState.phase === 'processing';

  const progressPercent =
    uploadState.phase === 'processing' && uploadState.progress.total > 0
      ? Math.round((uploadState.progress.current / uploadState.progress.total) * 100)
      : uploadState.phase === 'uploading' ? 5 : 0;

  return (
    <div className="flex min-h-screen flex-col" style={{ backgroundColor: '#0a0f1e' }}>
      {/* Header */}
      <div
        className="sticky top-0 z-10 flex items-center gap-3 px-4 pt-12 pb-4"
        style={{
          background: 'rgba(10,15,30,0.95)',
          backdropFilter: 'blur(20px)',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
        }}
      >
        <button
          onClick={() => setPage('settings')}
          className="flex h-9 w-9 items-center justify-center rounded-xl"
          style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)' }}
        >
          <ChevronLeft size={18} className="text-slate-400" />
        </button>
        <div>
          <h1 className="text-base font-bold text-white">إدارة المناهج</h1>
          <p className="text-[11px] text-slate-500">الرفع والمعالجة تتم على الخادم — لا قيود على الحجم</p>
        </div>
        <div
          className="mr-auto flex items-center gap-1.5 rounded-xl px-3 py-1.5"
          style={{ background: 'rgba(0,198,255,0.07)', border: '1px solid rgba(0,198,255,0.15)' }}
        >
          <Database size={11} className="text-[#00c6ff]" />
          <span className="text-[11px] text-[#00c6ff]">{docs.filter(d => d.status === 'done').length} كتاب</span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5 pb-10">

        {/* Upload Card */}
        <div
          className="rounded-2xl p-4 space-y-4"
          style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}
        >
          <h2 className="text-sm font-semibold text-white flex items-center gap-2">
            <Upload size={14} className="text-[#00c6ff]" />
            رفع كتاب مدرسي PDF
          </h2>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label className="text-[11px] text-slate-500">الدولة</label>
              <select
                value={country}
                onChange={(e) => { setCountry(e.target.value); setGrade(''); setSubject(''); }}
                disabled={isUploading}
                className="w-full rounded-xl px-3 py-2 text-sm text-white outline-none disabled:opacity-40"
                style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)' }}
              >
                <option value="">اختر...</option>
                {COUNTRY_OPTIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </div>

            <div className="space-y-1">
              <label className="text-[11px] text-slate-500">الصف الدراسي</label>
              <select
                value={grade}
                onChange={(e) => { setGrade(e.target.value); setSubject(''); }}
                disabled={!country || isUploading}
                className="w-full rounded-xl px-3 py-2 text-sm text-white outline-none disabled:opacity-40"
                style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)' }}
              >
                <option value="">اختر...</option>
                {GRADE_OPTIONS.map((g) => (
                  <option key={g.value} value={g.value}>{g.label} ({LEVEL_LABELS[g.level]})</option>
                ))}
              </select>
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-[11px] text-slate-500">المادة</label>
            <select
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              disabled={!grade || isUploading}
              className="w-full rounded-xl px-3 py-2 text-sm text-white outline-none disabled:opacity-40"
              style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)' }}
            >
              <option value="">اختر...</option>
              {availableSubjects.map((s) => <option key={s.id} value={s.id}>{s.icon} {s.label}</option>)}
            </select>
          </div>

          {/* Drop zone */}
          <div
            onDrop={handleFileDrop}
            onDragOver={(e) => e.preventDefault()}
            onClick={() => !isUploading && fileInputRef.current?.click()}
            className="flex flex-col items-center justify-center gap-2 rounded-2xl py-6 cursor-pointer transition-all"
            style={{
              border: file ? '2px solid rgba(0,198,255,0.5)' : '2px dashed rgba(255,255,255,0.1)',
              background: file ? 'rgba(0,198,255,0.05)' : 'rgba(255,255,255,0.02)',
              cursor: isUploading ? 'not-allowed' : 'pointer',
            }}
          >
            {file ? (
              <>
                <FileText size={24} className="text-[#00c6ff]" />
                <p className="text-sm text-[#00c6ff] font-medium">{file.name}</p>
                <p className="text-[11px] text-slate-500">{(file.size / 1024 / 1024).toFixed(1)} MB</p>
              </>
            ) : (
              <>
                <Upload size={24} className="text-slate-600" />
                <p className="text-sm text-slate-400">اسحب ملف PDF هنا أو اضغط للاختيار</p>
                <p className="text-[11px] text-slate-600">الحد الأقصى: 150 MB · المعالجة تتم على الخادم</p>
              </>
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf"
            className="hidden"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />

          {/* Status / Progress */}
          <AnimatePresence>
            {(uploadState.phase === 'uploading' || uploadState.phase === 'processing') && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="space-y-2"
              >
                <div className="flex items-center justify-between text-xs text-slate-400">
                  <span className="flex items-center gap-1.5">
                    <Loader2 size={12} className="animate-spin text-[#00c6ff]" />
                    {uploadState.phase === 'uploading' ? 'جاري الرفع...' : 'الخادم يعالج الكتاب...'}
                  </span>
                  {uploadState.phase === 'processing' && uploadState.progress.total > 0 && (
                    <span>{uploadState.progress.current} / {uploadState.progress.total} صفحة</span>
                  )}
                </div>
                <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
                  <motion.div
                    className="h-full rounded-full"
                    style={{ background: 'linear-gradient(90deg, #0090ff, #00c6ff)' }}
                    animate={{ width: `${progressPercent || 20}%` }}
                    transition={{ duration: 0.5 }}
                  />
                </div>
              </motion.div>
            )}

            {uploadState.phase === 'done' && (
              <motion.div
                initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                className="flex items-center gap-2 rounded-xl px-3 py-2 text-sm"
                style={{ background: 'rgba(52,211,153,0.08)', border: '1px solid rgba(52,211,153,0.2)', color: '#34d399' }}
              >
                <CheckCircle2 size={14} />
                تم! {uploadState.result.totalPages} صفحة → {uploadState.result.chunkCount} قسم. Sage جاهز للتدريس.
              </motion.div>
            )}

            {uploadState.phase === 'error' && (
              <motion.div
                initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                className="flex items-center gap-2 rounded-xl px-3 py-2 text-sm"
                style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)', color: '#f87171' }}
              >
                <AlertCircle size={14} />
                {uploadState.message}
              </motion.div>
            )}
          </AnimatePresence>

          <button
            onClick={handleUpload}
            disabled={!country || !grade || !subject || !file || isUploading}
            className="w-full rounded-2xl py-3 text-sm font-semibold text-white transition-all disabled:opacity-40"
            style={{ background: 'linear-gradient(135deg, #0090ff, #00c6ff)' }}
          >
            {isUploading ? 'جاري المعالجة...' : 'رفع ومعالجة على الخادم'}
          </button>
        </div>

        {/* Uploaded Books */}
        {loadingDocs ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 size={20} className="animate-spin text-slate-600" />
          </div>
        ) : docs.length > 0 ? (
          <div className="space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              الكتب المرفوعة ({docs.length})
            </h2>
            {docs.map((doc) => (
              <motion.div
                key={doc.id}
                layout
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex items-start gap-3 rounded-2xl p-3"
                style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}
              >
                <div
                  className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl"
                  style={{
                    background: doc.status === 'done' ? 'rgba(0,198,255,0.1)' : 'rgba(251,191,36,0.1)',
                    border: `1px solid ${doc.status === 'done' ? 'rgba(0,198,255,0.2)' : 'rgba(251,191,36,0.2)'}`,
                  }}
                >
                  {doc.status === 'done'
                    ? <BookOpen size={16} className="text-[#00c6ff]" />
                    : doc.status === 'error'
                    ? <AlertCircle size={16} className="text-red-400" />
                    : <Clock size={16} className="text-yellow-400 animate-pulse" />
                  }
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-white truncate">{doc.filename}</p>
                  <div className="flex flex-wrap gap-1.5 mt-1">
                    <span className="rounded-md px-1.5 py-0.5 text-[10px]" style={{ background: 'rgba(0,198,255,0.08)', color: '#7dd3fc' }}>
                      {doc.country === 'egypt' ? '🇪🇬 مصر' : '🇸🇩 السودان'}
                    </span>
                    <span className="rounded-md px-1.5 py-0.5 text-[10px]" style={{ background: 'rgba(255,255,255,0.05)', color: '#94a3b8' }}>
                      {gradeLabel(doc.grade)}
                    </span>
                    <span className="rounded-md px-1.5 py-0.5 text-[10px]" style={{ background: 'rgba(255,255,255,0.05)', color: '#94a3b8' }}>
                      {subjectLabel(doc.country, doc.grade, doc.subject)}
                    </span>
                    {doc.status === 'done' && (
                      <span className="rounded-md px-1.5 py-0.5 text-[10px]" style={{ background: 'rgba(52,211,153,0.08)', color: '#34d399' }}>
                        {doc.totalPages} صفحة · {doc.chunkCount} قسم
                      </span>
                    )}
                    {doc.status === 'processing' && (
                      <span className="rounded-md px-1.5 py-0.5 text-[10px]" style={{ background: 'rgba(251,191,36,0.08)', color: '#fbbf24' }}>
                        جاري المعالجة...
                      </span>
                    )}
                    {doc.status === 'error' && (
                      <span className="rounded-md px-1.5 py-0.5 text-[10px]" style={{ background: 'rgba(248,113,113,0.08)', color: '#f87171' }}>
                        فشل: {doc.errorMessage?.slice(0, 30)}
                      </span>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => handleDelete(doc.id)}
                  className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl"
                  style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.15)' }}
                >
                  <Trash2 size={13} className="text-red-400" />
                </button>
              </motion.div>
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-12 text-center gap-3">
            <div
              className="flex h-14 w-14 items-center justify-center rounded-2xl"
              style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}
            >
              <BookOpen size={24} className="text-slate-600" />
            </div>
            <p className="text-sm text-slate-500">لا توجد كتب مرفوعة بعد</p>
            <p className="text-xs text-slate-600">ارفع أول كتاب مدرسي لتفعيل التدريس المبني على المنهج</p>
          </div>
        )}
      </div>
    </div>
  );
}
