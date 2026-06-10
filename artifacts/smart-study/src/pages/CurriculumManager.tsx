import { useState, useRef, useCallback, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Upload, Trash2, BookOpen, CheckCircle2, AlertCircle,
  Loader2, ChevronLeft, Database, FileText, Clock,
  StickyNote, GraduationCap, ScanLine, Zap, RefreshCw, Play,
} from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import {
  uploadCurriculumPdf,
  getJobStatus,
  getCurriculumDocs,
  deleteCurriculumDoc,
  resumeCurriculumDoc,
  getMe,
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

type DocType = 'book' | 'note' | 'exam';

const DOC_TYPE_OPTIONS: { value: DocType; label: string; icon: typeof BookOpen; color: string }[] = [
  { value: 'book', label: 'كتاب مدرسي', icon: BookOpen, color: '#00c6ff' },
  { value: 'note', label: 'ملاحظات', icon: StickyNote, color: '#34d399' },
  { value: 'exam', label: 'امتحان', icon: GraduationCap, color: '#f59e0b' },
];

const DOC_TYPE_LABELS: Record<DocType, { label: string; color: string }> = {
  book: { label: 'كتاب', color: '#7dd3fc' },
  note: { label: 'ملاحظات', color: '#6ee7b7' },
  exam: { label: 'امتحان', color: '#fcd34d' },
};

type UploadState =
  | { phase: 'idle' }
  | { phase: 'uploading' }
  | { phase: 'processing'; jobId: string; progress: { current: number; total: number } }
  | { phase: 'ocr_running'; jobId: string }
  | { phase: 'done'; result: { totalPages: number; chunkCount: number; extractionMethod?: 'text' | 'virtual' | 'ocr'; extractedChars?: number; avgCharsPerPage?: number } }
  | { phase: 'error'; message: string };

export default function CurriculumManager() {
  const setPage = useAppStore((s) => s.setPage);
  const studentProfile = useAppStore((s) => s.studentProfile);

  const [docs, setDocs] = useState<CurriculumDocMeta[]>([]);
  const [loadingDocs, setLoadingDocs] = useState(true);

  const [isAdmin, setIsAdmin]     = useState(false);
  const [adminChecked, setAdminChecked] = useState(false);

  const [docType, setDocType] = useState<DocType>('book');
  const [country, setCountry] = useState<'' | 'egypt' | 'sudan'>(
    (studentProfile?.country as '' | 'egypt' | 'sudan') ?? ''
  );
  const [grade, setGrade]     = useState('');
  const [subject, setSubject] = useState('');
  const [bookTitle, setBookTitle] = useState('');
  const [file, setFile]       = useState<File | null>(null);
  const [uploadState, setUploadState] = useState<UploadState>({ phase: 'idle' });

  const [resumingDocIds, setResumingDocIds] = useState<Set<string>>(new Set());

  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const selectedGradeOption = GRADE_OPTIONS.find((g) => g.value === grade);
  const levelForGrade = selectedGradeOption?.level ?? '';
  const availableSubjects = getSubjects(
    country as 'egypt' | 'sudan' | '',
    levelForGrade as 'primary' | 'preparatory' | 'secondary' | '',
    ''
  );

  // Fetch admin status once on mount
  useEffect(() => {
    getMe().then((me) => {
      setIsAdmin(me?.isAdmin ?? false);
      setAdminChecked(true);
      // Default to 'note' for non-admins since they can't upload books
      if (!me?.isAdmin) setDocType('note');
    });
  }, []);

  const refreshDocs = useCallback(async () => {
    try {
      const data = await getCurriculumDocs();
      setDocs(data);
    } catch { /* ignore */ } finally {
      setLoadingDocs(false);
    }
  }, []);

  useEffect(() => { refreshDocs(); }, [refreshDocs]);

  // Auto-refresh every 30 s so partial/resuming/processing docs update without user action
  useEffect(() => {
    const id = setInterval(() => {
      const hasLiveDocs = docs.some((d) =>
        d.status === 'partial' || d.status === 'resuming' ||
        d.status === 'processing' || d.status === 'ocr_running' || d.status === 'queued'
      );
      if (hasLiveDocs) refreshDocs();
    }, 30_000);
    return () => clearInterval(id);
  }, [docs, refreshDocs]);

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
        } else if (status.status === 'ocr_running') {
          setUploadState({ phase: 'ocr_running', jobId });
        } else if (status.status === 'done' && status.result) {
          stopPolling();
          setUploadState({ phase: 'done', result: status.result });
          await refreshDocs();
          setFile(null);
          setGrade('');
          setSubject('');
          setBookTitle('');
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
      const { jobId } = await uploadCurriculumPdf(file, {
        country, grade, subject, docType,
        bookTitle: bookTitle.trim() || undefined,
      });
      setUploadState({ phase: 'processing', jobId, progress: { current: 0, total: 0 } });
      startPolling(jobId);
    } catch (err) {
      setUploadState({ phase: 'error', message: err instanceof Error ? err.message : 'فشل الرفع' });
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteCurriculumDoc(id);
      await refreshDocs();
    } catch (err) {
      setUploadState({ phase: 'error', message: err instanceof Error ? err.message : 'فشل الحذف' });
    }
  };

  const handleResume = async (docId: string) => {
    setResumingDocIds((prev) => new Set(prev).add(docId));
    try {
      await resumeCurriculumDoc(docId);
      await refreshDocs();
    } catch (err) {
      setUploadState({ phase: 'error', message: err instanceof Error ? err.message : 'فشل الاستئناف' });
    } finally {
      setResumingDocIds((prev) => { const s = new Set(prev); s.delete(docId); return s; });
    }
  };

  const classifyOcrError = (doc: CurriculumDocMeta): { label: string; color: string } | null => {
    const msg = (doc.errorMessage ?? doc.lastResumeError ?? '').toLowerCase();
    if (!msg) return null;
    if (msg.includes('429') || msg.includes('quota')) return { label: 'استنزفت حصة Gemini (429)', color: '#f87171' };
    if (msg.includes('503') || msg.includes('unavailable') || msg.includes('overloaded')) return { label: 'Gemini مشغول — ازدحام (503)', color: '#fb923c' };
    if (msg.includes('pdf') && (msg.includes('not found') || msg.includes('missing'))) return { label: 'ملف PDF مفقود', color: '#f87171' };
    if (msg.includes('no gemini_api_key') || msg.includes('gemini_api_key')) return { label: 'مفتاح API مفقود', color: '#f87171' };
    return { label: 'فشل OCR', color: '#f87171' };
  };

  const gradeLabel = (g: string) => GRADE_OPTIONS.find((o) => o.value === g)?.label ?? g;

  const subjectLabel = (docCountry: string, docGrade: string, subjectId: string) => {
    const level = GRADE_OPTIONS.find((g) => g.value === docGrade)?.level ?? '';
    return getSubjects(
      docCountry as 'egypt' | 'sudan' | '',
      level as 'primary' | 'preparatory' | 'secondary' | '',
      ''
    ).find((s) => s.id === subjectId)?.label ?? subjectId;
  };

  const isUploading =
    uploadState.phase === 'uploading' ||
    uploadState.phase === 'processing' ||
    uploadState.phase === 'ocr_running';

  const progressPercent =
    uploadState.phase === 'processing' && uploadState.progress.total > 0
      ? Math.round((uploadState.progress.current / uploadState.progress.total) * 100)
      : uploadState.phase === 'ocr_running' ? 65   // indeterminate mid-point
      : uploadState.phase === 'uploading'   ? 5
      : 0;

  const activeDocTypeOption = DOC_TYPE_OPTIONS.find((d) => d.value === docType)!;

  // Group docs by type for display
  const filterLabel = { book: 'الكتب', note: 'الملاحظات', exam: 'الامتحانات' };
  const booksDone = docs.filter((d) => d.status === 'done' && (!d.docType || d.docType === 'book')).length;
  const notesDone = docs.filter((d) => d.status === 'done' && d.docType === 'note').length;
  const examsDone = docs.filter((d) => d.status === 'done' && d.docType === 'exam').length;

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
          <h1 className="text-base font-bold text-white">إدارة المواد الدراسية</h1>
          <p className="text-[11px] text-slate-500">الرفع والمعالجة تتم على الخادم — لا قيود على الحجم</p>
        </div>
        <div className="mr-auto flex items-center gap-1.5 flex-shrink-0">
          {[
            { count: booksDone, label: 'كتب', color: '#00c6ff' },
            { count: notesDone, label: 'ملاح.', color: '#34d399' },
            { count: examsDone, label: 'امت.', color: '#f59e0b' },
          ].map(({ count, label, color }) => count > 0 && (
            <div
              key={label}
              className="flex items-center gap-1 rounded-xl px-2 py-1"
              style={{ background: `${color}12`, border: `1px solid ${color}25` }}
            >
              <Database size={9} style={{ color }} />
              <span className="text-[10px]" style={{ color }}>{count} {label}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5 pb-10">

        {/* Upload Card */}
        <div
          className="rounded-2xl p-4 space-y-4"
          style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}
        >
          {/* Doc type tabs */}
          <div className="space-y-2">
            <label className="text-[11px] text-slate-500">نوع الملف</label>
            <div className={`grid gap-2 ${isAdmin ? 'grid-cols-3' : 'grid-cols-2'}`}>
              {DOC_TYPE_OPTIONS.filter((opt) => isAdmin || opt.value !== 'book').map((opt) => {
                const Icon = opt.icon;
                const isActive = docType === opt.value;
                return (
                  <motion.button
                    key={opt.value}
                    whileTap={{ scale: 0.96 }}
                    onClick={() => !isUploading && setDocType(opt.value)}
                    disabled={isUploading}
                    className="flex flex-col items-center gap-1 rounded-xl py-2.5 px-2 text-[11px] font-medium transition-all disabled:opacity-40"
                    style={{
                      background: isActive ? `${opt.color}18` : 'rgba(255,255,255,0.04)',
                      border: isActive ? `1px solid ${opt.color}40` : '1px solid rgba(255,255,255,0.07)',
                      color: isActive ? opt.color : '#64748b',
                    }}
                  >
                    <Icon size={14} />
                    {opt.label}
                  </motion.button>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label className="text-[11px] text-slate-500">الدولة</label>
              <select
                value={country}
                onChange={(e) => { setCountry(e.target.value as '' | 'egypt' | 'sudan'); setGrade(''); setSubject(''); }}
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

          {/* Book title — admins uploading 'book', or any doc type (optional label) */}
          {docType === 'book' && (
            <div className="space-y-1 mt-2">
              <label className="text-[11px] text-slate-500">
                عنوان الكتاب
                <span className="opacity-50 mr-1">(مثال: النحو والصرف · فيزياء 3)</span>
              </label>
              <input
                type="text"
                dir="rtl"
                value={bookTitle}
                onChange={(e) => setBookTitle(e.target.value)}
                disabled={isUploading}
                placeholder="يملأ تلقائياً من اسم الملف إن تُرك فارغاً"
                className="w-full rounded-xl px-3 py-2 text-sm text-white placeholder-slate-600 outline-none disabled:opacity-40"
                style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)' }}
              />
            </div>
          )}
          </div>

          {/* Drop zone */}
          <div
            onDrop={handleFileDrop}
            onDragOver={(e) => e.preventDefault()}
            onClick={() => !isUploading && fileInputRef.current?.click()}
            className="flex flex-col items-center justify-center gap-2 rounded-2xl py-6 transition-all"
            style={{
              border: file ? `2px solid ${activeDocTypeOption.color}80` : '2px dashed rgba(255,255,255,0.1)',
              background: file ? `${activeDocTypeOption.color}08` : 'rgba(255,255,255,0.02)',
              cursor: isUploading ? 'not-allowed' : 'pointer',
            }}
          >
            {file ? (
              <>
                <FileText size={24} style={{ color: activeDocTypeOption.color }} />
                <p className="text-sm font-medium" style={{ color: activeDocTypeOption.color }}>{file.name}</p>
                <p className="text-[11px] text-slate-500">{(file.size / 1024 / 1024).toFixed(1)} MB</p>
              </>
            ) : (
              <>
                <Upload size={24} className="text-slate-600" />
                <p className="text-sm text-slate-400">
                  اسحب ملف PDF هنا أو اضغط للاختيار
                </p>
                <p className="text-[11px] text-slate-600">
                  {docType === 'note' ? 'ملاحظاتك PDF · حتى 150 MB' :
                   docType === 'exam' ? 'نموذج امتحان PDF · حتى 150 MB' :
                   'كتاب مدرسي PDF · حتى 150 MB · OCR للمسوحات الضوئية'}
                </p>
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
            {(uploadState.phase === 'uploading' || uploadState.phase === 'processing' || uploadState.phase === 'ocr_running') && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="space-y-2"
              >
                <div className="flex items-center justify-between text-xs text-slate-400">
                  <span className="flex items-center gap-1.5">
                    {uploadState.phase === 'ocr_running' ? (
                      <ScanLine size={12} className="animate-pulse text-amber-400" />
                    ) : (
                      <Loader2 size={12} className="animate-spin text-[#00c6ff]" />
                    )}
                    {uploadState.phase === 'uploading'
                      ? 'جاري الرفع...'
                      : uploadState.phase === 'ocr_running'
                        ? 'النص متفرق — OCR يستخرج الصفحات...'
                        : 'الخادم يعالج الملف...'}
                  </span>
                  {uploadState.phase === 'processing' && uploadState.progress.total > 0 && (
                    <span>{uploadState.progress.current} / {uploadState.progress.total} صفحة</span>
                  )}
                  {uploadState.phase === 'ocr_running' && (
                    <span className="text-amber-400/70">Gemini Vision</span>
                  )}
                </div>
                <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
                  <motion.div
                    className="h-full rounded-full"
                    style={{
                      background: uploadState.phase === 'ocr_running'
                        ? 'linear-gradient(90deg, rgba(245,158,11,0.7), #f59e0b)'
                        : `linear-gradient(90deg, ${activeDocTypeOption.color}99, ${activeDocTypeOption.color})`,
                    }}
                    animate={{ width: `${progressPercent || 20}%` }}
                    transition={{ duration: 0.5 }}
                  />
                </div>
              </motion.div>
            )}

            {uploadState.phase === 'done' && (
              <motion.div
                initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                className="rounded-xl px-3 py-2.5 space-y-1.5"
                style={{ background: 'rgba(52,211,153,0.08)', border: '1px solid rgba(52,211,153,0.2)' }}
              >
                <div className="flex items-center gap-2 text-sm" style={{ color: '#34d399' }}>
                  <CheckCircle2 size={14} />
                  تم! {uploadState.result.totalPages} صفحة → {uploadState.result.chunkCount} قسم. Sage جاهز للتدريس.
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  {uploadState.result.extractionMethod && (
                    <span
                      className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium"
                      style={uploadState.result.extractionMethod === 'ocr'
                        ? { background: 'rgba(245,158,11,0.12)', color: '#fbbf24', border: '1px solid rgba(245,158,11,0.2)' }
                        : { background: 'rgba(0,198,255,0.08)', color: '#7dd3fc', border: '1px solid rgba(0,198,255,0.15)' }
                      }
                    >
                      {uploadState.result.extractionMethod === 'ocr' ? <ScanLine size={9} /> : <Zap size={9} />}
                      {uploadState.result.extractionMethod === 'ocr' ? 'OCR' : uploadState.result.extractionMethod === 'virtual' ? 'Virtual Split' : 'Text'}
                    </span>
                  )}
                  {uploadState.result.avgCharsPerPage != null && (
                    <span className="text-[10px] text-slate-500">
                      ~{uploadState.result.avgCharsPerPage} حرف/صفحة
                    </span>
                  )}
                </div>
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
            style={{ background: `linear-gradient(135deg, ${activeDocTypeOption.color}99, ${activeDocTypeOption.color})` }}
          >
            {isUploading ? 'جاري المعالجة...' : `رفع ${activeDocTypeOption.label} ومعالجته`}
          </button>
        </div>

        {/* Uploaded Docs */}
        {loadingDocs ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 size={20} className="animate-spin text-slate-600" />
          </div>
        ) : docs.length > 0 ? (
          <div className="space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              الملفات المرفوعة ({docs.length})
            </h2>
            {docs.map((doc) => {
              const dt = (doc.docType as DocType | undefined) ?? 'book';
              const dtInfo = DOC_TYPE_LABELS[dt] ?? DOC_TYPE_LABELS.book;
              return (
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
                      background:
                        doc.status === 'done' ? `${dtInfo.color}18` :
                        doc.status === 'error' ? 'rgba(248,113,113,0.1)' :
                        doc.status === 'partial' ? 'rgba(251,191,36,0.08)' :
                        doc.status === 'resuming' ? 'rgba(139,92,246,0.1)' :
                        'rgba(251,191,36,0.1)',
                      border: `1px solid ${
                        doc.status === 'done' ? dtInfo.color + '35' :
                        doc.status === 'error' ? 'rgba(248,113,113,0.25)' :
                        doc.status === 'partial' ? 'rgba(251,191,36,0.2)' :
                        doc.status === 'resuming' ? 'rgba(139,92,246,0.25)' :
                        'rgba(251,191,36,0.2)'
                      }`,
                    }}
                  >
                    {doc.status === 'done'
                      ? dt === 'note' ? <StickyNote size={16} style={{ color: dtInfo.color }} />
                        : dt === 'exam' ? <GraduationCap size={16} style={{ color: dtInfo.color }} />
                        : <BookOpen size={16} style={{ color: dtInfo.color }} />
                      : doc.status === 'error'
                      ? <AlertCircle size={16} className="text-red-400" />
                      : doc.status === 'partial'
                      ? <Clock size={16} className="text-yellow-400" />
                      : doc.status === 'resuming'
                      ? <RefreshCw size={16} className="text-violet-400 animate-spin" />
                      : doc.status === 'ocr_running'
                      ? <ScanLine size={16} className="text-amber-400 animate-pulse" />
                      : <Loader2 size={16} className="text-yellow-400 animate-spin" />
                    }
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-white truncate">{doc.filename}</p>
                    <div className="flex flex-wrap gap-1.5 mt-1">
                      <span className="rounded-md px-1.5 py-0.5 text-[10px]" style={{ background: `${dtInfo.color}12`, color: dtInfo.color }}>
                        {dtInfo.label}
                      </span>
                      <span className="rounded-md px-1.5 py-0.5 text-[10px]" style={{ background: 'rgba(0,198,255,0.08)', color: '#7dd3fc' }}>
                        {doc.country === 'egypt' ? '🇪🇬 مصر' : '🇸🇩 السودان'}
                      </span>
                      <span className="rounded-md px-1.5 py-0.5 text-[10px]" style={{ background: 'rgba(255,255,255,0.05)', color: '#94a3b8' }}>
                        {gradeLabel(doc.grade)}
                      </span>
                      <span className="rounded-md px-1.5 py-0.5 text-[10px]" style={{ background: 'rgba(255,255,255,0.05)', color: '#94a3b8' }}>
                        {subjectLabel(doc.country, doc.grade, doc.subject)}
                      </span>
                      {doc.bookTitle && (
                        <span className="rounded-md px-1.5 py-0.5 text-[10px] max-w-[120px] truncate" style={{ background: 'rgba(0,198,255,0.07)', color: '#7dd3fc', border: '1px solid rgba(0,198,255,0.12)' }}>
                          {doc.bookTitle}
                        </span>
                      )}
                      {doc.visibility === 'private' && (
                        <span className="rounded-md px-1.5 py-0.5 text-[10px]" style={{ background: 'rgba(139,92,246,0.08)', color: '#a78bfa', border: '1px solid rgba(139,92,246,0.15)' }}>
                          خاص
                        </span>
                      )}
                      {doc.status === 'done' && (
                        <>
                          <span className="rounded-md px-1.5 py-0.5 text-[10px]" style={{ background: 'rgba(52,211,153,0.08)', color: '#34d399' }}>
                            {doc.totalPages} صفحة · {doc.chunkCount} قسم
                          </span>
                          {doc.extractionMethod && (
                            <span
                              className="flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[10px]"
                              title={`${doc.extractedChars?.toLocaleString()} حرف مستخرج · ${doc.avgCharsPerPage ?? '?'} حرف/صفحة`}
                              style={doc.extractionMethod === 'ocr'
                                ? { background: 'rgba(245,158,11,0.1)', color: '#fbbf24', border: '1px solid rgba(245,158,11,0.18)' }
                                : { background: 'rgba(0,198,255,0.07)', color: '#7dd3fc', border: '1px solid rgba(0,198,255,0.12)' }
                              }
                            >
                              {doc.extractionMethod === 'ocr' ? <ScanLine size={9} /> : <Zap size={9} />}
                              {doc.extractionMethod === 'ocr' ? 'OCR' : doc.extractionMethod === 'virtual' ? 'Virtual' : 'Text'}
                              {doc.avgCharsPerPage != null && ` · ${doc.avgCharsPerPage}/p`}
                            </span>
                          )}
                        </>
                      )}
                      {(doc.status === 'processing' || doc.status === 'queued') && (
                        <span className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px]" style={{ background: 'rgba(251,191,36,0.08)', color: '#fbbf24' }}>
                          <Loader2 size={9} className="animate-spin" />
                          جاري المعالجة...
                        </span>
                      )}
                      {doc.status === 'ocr_running' && (
                        <span className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px]" style={{ background: 'rgba(245,158,11,0.1)', color: '#f59e0b' }}>
                          <ScanLine size={9} className="animate-pulse" />
                          OCR يعمل...
                        </span>
                      )}
                      {doc.status === 'partial' && (() => {
                        const errInfo = classifyOcrError(doc);
                        const pct = doc.lastRenderedPage != null && doc.totalPages > 0
                          ? Math.round((doc.lastRenderedPage / doc.totalPages) * 100)
                          : null;
                        return (
                          <>
                            <span className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px]" style={{ background: 'rgba(251,191,36,0.08)', color: '#fbbf24', border: '1px solid rgba(251,191,36,0.2)' }}>
                              <Clock size={9} />
                              جزئي
                              {doc.lastRenderedPage != null && doc.totalPages > 0
                                ? <span className="opacity-80 mr-0.5">{doc.lastRenderedPage}/{doc.totalPages} ص{pct != null ? ` (${pct}%)` : ''}</span>
                                : doc.lastRenderedPage != null && <span className="opacity-60 mr-0.5">ص {doc.lastRenderedPage}</span>
                              }
                            </span>
                            {errInfo && (
                              <span className="rounded-md px-1.5 py-0.5 text-[10px]" style={{ background: 'rgba(248,113,113,0.07)', color: errInfo.color, border: `1px solid ${errInfo.color}30` }}>
                                {errInfo.label}
                              </span>
                            )}
                          </>
                        );
                      })()}
                      {doc.status === 'partial' && (doc.resumeAttempts ?? 0) > 0 && (
                        <span className="rounded-md px-1.5 py-0.5 text-[10px]" style={{ background: 'rgba(139,92,246,0.08)', color: '#a78bfa' }}>
                          محاولة {doc.resumeAttempts}
                          {doc.lastResumeAttempt && (
                            <span className="opacity-60 mr-0.5">
                              · {new Date(doc.lastResumeAttempt).toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit' })}
                            </span>
                          )}
                        </span>
                      )}
                      {doc.status === 'resuming' && (
                        <span className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px]" style={{ background: 'rgba(139,92,246,0.1)', color: '#a78bfa', border: '1px solid rgba(139,92,246,0.2)' }}>
                          <RefreshCw size={9} className="animate-spin" />
                          جاري الاستئناف التلقائي...
                        </span>
                      )}
                      {doc.status === 'error' && (() => {
                        const errInfo = classifyOcrError(doc);
                        return (
                          <span className="rounded-md px-1.5 py-0.5 text-[10px]" style={{ background: 'rgba(248,113,113,0.07)', color: errInfo?.color ?? '#f87171', border: `1px solid ${errInfo?.color ?? '#f87171'}30` }}>
                            {errInfo?.label ?? `فشل: ${doc.errorMessage?.slice(0, 30)}`}
                          </span>
                        );
                      })()}
                    </div>
                  </div>
                  <div className="flex flex-col gap-1.5 flex-shrink-0">
                    {isAdmin && (doc.status === 'partial' || doc.status === 'error') && (
                      <button
                        onClick={() => handleResume(doc.id)}
                        disabled={resumingDocIds.has(doc.id)}
                        title="استئناف OCR من آخر صفحة"
                        className="flex h-8 w-8 items-center justify-center rounded-xl disabled:opacity-40"
                        style={{ background: 'rgba(139,92,246,0.12)', border: '1px solid rgba(139,92,246,0.25)' }}
                      >
                        {resumingDocIds.has(doc.id)
                          ? <Loader2 size={13} className="text-violet-400 animate-spin" />
                          : <Play size={12} className="text-violet-400" />
                        }
                      </button>
                    )}
                    <button
                      onClick={() => handleDelete(doc.id)}
                      className="flex h-8 w-8 items-center justify-center rounded-xl"
                      style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.15)' }}
                    >
                      <Trash2 size={13} className="text-red-400" />
                    </button>
                  </div>
                </motion.div>
              );
            })}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-12 text-center gap-3">
            <div
              className="flex h-14 w-14 items-center justify-center rounded-2xl"
              style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}
            >
              <BookOpen size={24} className="text-slate-600" />
            </div>
            <p className="text-sm text-slate-500">لا توجد ملفات مرفوعة بعد</p>
            <p className="text-xs text-slate-600">ارفع كتاباً أو ملاحظات أو امتحاناً لتفعيل التدريس المبني على المنهج</p>
          </div>
        )}
      </div>
    </div>
  );
}
