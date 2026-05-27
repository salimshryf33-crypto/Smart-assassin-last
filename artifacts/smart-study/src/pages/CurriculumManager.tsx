import { useState, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Upload, Trash2, BookOpen, CheckCircle2, AlertCircle,
  Loader2, ChevronLeft, Database, FileText,
} from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import {
  getAllCurriculumDocs,
  saveCurriculumDoc,
  deleteCurriculumDoc,
  getCurriculumStorageSizeKB,
} from '../utils/curriculumStore';
import { parsePDF, type ParseProgress } from '../utils/pdfParser';
import type { CurriculumDocument } from '../data/curriculum/types';
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

export default function CurriculumManager() {
  const setPage = useAppStore((s) => s.setPage);

  const [docs, setDocs] = useState<CurriculumDocument[]>(getAllCurriculumDocs);

  const [country, setCountry] = useState('');
  const [grade, setGrade] = useState('');
  const [subject, setSubject] = useState('');
  const [file, setFile] = useState<File | null>(null);

  const [status, setStatus] = useState<'idle' | 'parsing' | 'done' | 'error'>('idle');
  const [progress, setProgress] = useState<ParseProgress | null>(null);
  const [errorMsg, setErrorMsg] = useState('');

  const fileInputRef = useRef<HTMLInputElement>(null);

  const selectedGradeOption = GRADE_OPTIONS.find((g) => g.value === grade);
  const levelForGrade = selectedGradeOption?.level ?? '';
  const availableSubjects = getSubjects(
    country as 'egypt' | 'sudan' | '',
    levelForGrade as 'primary' | 'preparatory' | 'secondary' | '',
    ''
  );

  const handleFileDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const dropped = e.dataTransfer.files[0];
    if (dropped?.type === 'application/pdf') setFile(dropped);
  }, []);

  const handleUpload = async () => {
    if (!country || !grade || !subject || !file) return;

    setStatus('parsing');
    setProgress(null);
    setErrorMsg('');

    try {
      const docId = `${country}-${grade}-${subject}-${Date.now()}`;
      const { chunks, totalPages } = await parsePDF(
        file,
        docId,
        country,
        grade,
        subject,
        (p) => setProgress(p)
      );

      const doc: CurriculumDocument = {
        id: docId,
        country,
        grade,
        subject,
        filename: file.name,
        uploadedAt: Date.now(),
        totalPages,
        chunks,
      };

      saveCurriculumDoc(doc);
      setDocs(getAllCurriculumDocs());
      setStatus('done');
      setFile(null);
      setGrade('');
      setSubject('');
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'فشل في تحليل الملف');
      setStatus('error');
    }
  };

  const handleDelete = (id: string) => {
    deleteCurriculumDoc(id);
    setDocs(getAllCurriculumDocs());
  };

  const gradeLabel = (g: string) =>
    GRADE_OPTIONS.find((o) => o.value === g)?.label ?? g;

  const subjectLabel = (country: string, grade: string, subjectId: string) => {
    const level = GRADE_OPTIONS.find((g) => g.value === grade)?.level ?? '';
    const subs = getSubjects(
      country as 'egypt' | 'sudan' | '',
      level as 'primary' | 'preparatory' | 'secondary' | '',
      ''
    );
    return subs.find((s) => s.id === subjectId)?.label ?? subjectId;
  };

  const storageKB = getCurriculumStorageSizeKB();

  return (
    <div className="flex min-h-screen flex-col" style={{ backgroundColor: '#0a0f1e' }}>
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
          <p className="text-[11px] text-slate-500">ارفع كتب المنهج لتدريس مبني على المحتوى الرسمي</p>
        </div>
        <div className="mr-auto flex items-center gap-1.5 rounded-xl px-3 py-1.5"
          style={{ background: 'rgba(0,198,255,0.07)', border: '1px solid rgba(0,198,255,0.15)' }}>
          <Database size={11} className="text-[#00c6ff]" />
          <span className="text-[11px] text-[#00c6ff]">{storageKB} KB</span>
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
            رفع كتاب مدرسي
          </h2>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label className="text-[11px] text-slate-500">الدولة</label>
              <select
                value={country}
                onChange={(e) => { setCountry(e.target.value); setGrade(''); setSubject(''); }}
                className="w-full rounded-xl px-3 py-2 text-sm text-white outline-none"
                style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)' }}
              >
                <option value="">اختر...</option>
                {COUNTRY_OPTIONS.map((c) => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <label className="text-[11px] text-slate-500">الصف الدراسي</label>
              <select
                value={grade}
                onChange={(e) => { setGrade(e.target.value); setSubject(''); }}
                disabled={!country}
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
              disabled={!grade}
              className="w-full rounded-xl px-3 py-2 text-sm text-white outline-none disabled:opacity-40"
              style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)' }}
            >
              <option value="">اختر...</option>
              {availableSubjects.map((s) => (
                <option key={s.id} value={s.id}>{s.icon} {s.label}</option>
              ))}
            </select>
          </div>

          <div
            onDrop={handleFileDrop}
            onDragOver={(e) => e.preventDefault()}
            onClick={() => fileInputRef.current?.click()}
            className="flex flex-col items-center justify-center gap-2 rounded-2xl py-6 cursor-pointer transition-all"
            style={{
              border: file
                ? '2px solid rgba(0,198,255,0.5)'
                : '2px dashed rgba(255,255,255,0.1)',
              background: file ? 'rgba(0,198,255,0.05)' : 'rgba(255,255,255,0.02)',
            }}
          >
            {file ? (
              <>
                <FileText size={24} className="text-[#00c6ff]" />
                <p className="text-sm text-[#00c6ff] font-medium">{file.name}</p>
                <p className="text-[11px] text-slate-500">
                  {(file.size / 1024 / 1024).toFixed(1)} MB
                </p>
              </>
            ) : (
              <>
                <Upload size={24} className="text-slate-600" />
                <p className="text-sm text-slate-400">اسحب ملف PDF هنا أو اضغط للاختيار</p>
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

          <AnimatePresence>
            {status === 'parsing' && progress && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="space-y-2"
              >
                <div className="flex items-center justify-between text-xs text-slate-400">
                  <span className="flex items-center gap-1.5">
                    <Loader2 size={12} className="animate-spin text-[#00c6ff]" />
                    جاري تحليل الصفحات...
                  </span>
                  <span>{progress.current} / {progress.total}</span>
                </div>
                <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
                  <motion.div
                    className="h-full rounded-full"
                    style={{ background: 'linear-gradient(90deg, #0090ff, #00c6ff)' }}
                    animate={{ width: `${(progress.current / progress.total) * 100}%` }}
                    transition={{ duration: 0.3 }}
                  />
                </div>
              </motion.div>
            )}

            {status === 'done' && (
              <motion.div
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="flex items-center gap-2 rounded-xl px-3 py-2 text-sm"
                style={{ background: 'rgba(52,211,153,0.08)', border: '1px solid rgba(52,211,153,0.2)', color: '#34d399' }}
              >
                <CheckCircle2 size={14} />
                تم رفع الكتاب بنجاح! Sage سيستخدمه في التدريس.
              </motion.div>
            )}

            {status === 'error' && (
              <motion.div
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="flex items-center gap-2 rounded-xl px-3 py-2 text-sm"
                style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)', color: '#f87171' }}
              >
                <AlertCircle size={14} />
                {errorMsg}
              </motion.div>
            )}
          </AnimatePresence>

          <button
            onClick={handleUpload}
            disabled={!country || !grade || !subject || !file || status === 'parsing'}
            className="w-full rounded-2xl py-3 text-sm font-semibold text-white transition-all disabled:opacity-40"
            style={{ background: 'linear-gradient(135deg, #0090ff, #00c6ff)' }}
          >
            {status === 'parsing' ? 'جاري التحليل...' : 'رفع وتحليل الكتاب'}
          </button>
        </div>

        {/* Uploaded Books */}
        {docs.length > 0 && (
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
                exit={{ opacity: 0, x: -20 }}
                className="flex items-start gap-3 rounded-2xl p-3"
                style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}
              >
                <div
                  className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl"
                  style={{ background: 'rgba(0,198,255,0.1)', border: '1px solid rgba(0,198,255,0.2)' }}
                >
                  <BookOpen size={16} className="text-[#00c6ff]" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-white truncate">{doc.filename}</p>
                  <div className="flex flex-wrap gap-1.5 mt-1">
                    <span className="rounded-md px-1.5 py-0.5 text-[10px]"
                      style={{ background: 'rgba(0,198,255,0.08)', color: '#7dd3fc' }}>
                      {doc.country === 'egypt' ? '🇪🇬 مصر' : '🇸🇩 السودان'}
                    </span>
                    <span className="rounded-md px-1.5 py-0.5 text-[10px]"
                      style={{ background: 'rgba(255,255,255,0.05)', color: '#94a3b8' }}>
                      {gradeLabel(doc.grade)}
                    </span>
                    <span className="rounded-md px-1.5 py-0.5 text-[10px]"
                      style={{ background: 'rgba(255,255,255,0.05)', color: '#94a3b8' }}>
                      {subjectLabel(doc.country, doc.grade, doc.subject)}
                    </span>
                    <span className="rounded-md px-1.5 py-0.5 text-[10px]"
                      style={{ background: 'rgba(255,255,255,0.03)', color: '#64748b' }}>
                      {doc.totalPages} صفحة · {doc.chunks.length} قسم
                    </span>
                  </div>
                </div>
                <button
                  onClick={() => handleDelete(doc.id)}
                  className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl transition-all"
                  style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.15)' }}
                >
                  <Trash2 size={13} className="text-red-400" />
                </button>
              </motion.div>
            ))}
          </div>
        )}

        {docs.length === 0 && (
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
