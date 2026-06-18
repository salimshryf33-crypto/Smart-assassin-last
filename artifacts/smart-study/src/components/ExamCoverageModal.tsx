import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X, BarChart3, AlertTriangle, CheckCircle2,
  FileText, Eye, ChevronDown, ChevronUp,
} from 'lucide-react';
import { getExamCoverage, type ExamCoverageReport, type CoverageChunk } from '../utils/curriculumApi';

const C = {
  blue:   '#00c6ff',
  gold:   '#f59e0b',
  green:  '#34d399',
  red:    '#f87171',
  orange: '#fb923c',
  bg:     '#0a0f1e',
};

// ─── OCR Score bar ────────────────────────────────────────────────────────────
function OcrScoreBar({ score }: { score: number }) {
  const color = score >= 60 ? C.green : score >= 35 ? C.gold : C.red;
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.07)' }}>
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${score}%` }}
          transition={{ duration: 0.6, ease: 'easeOut' }}
          className="h-full rounded-full"
          style={{ background: color }}
        />
      </div>
      <span className="text-[10px] font-bold w-7 text-right" style={{ color }}>{score}</span>
    </div>
  );
}

// ─── Single chunk row ─────────────────────────────────────────────────────────
function ChunkRow({ chunk, index }: { chunk: CoverageChunk; index: number }) {
  const [expanded, setExpanded] = useState(false);
  const hasQuestions = chunk.extracted > 0;
  const isSkipped    = chunk.failureReason?.includes('تم التخطي');

  const dotColor = hasQuestions ? C.green
    : isSkipped   ? '#475569'
    : chunk.isLowConfidence ? C.red
    : C.orange;

  return (
    <div
      className="rounded-xl overflow-hidden mb-2"
      style={{
        background: 'rgba(255,255,255,0.02)',
        border: `1px solid ${hasQuestions ? 'rgba(52,211,153,0.12)' : isSkipped ? 'rgba(255,255,255,0.04)' : 'rgba(248,113,113,0.1)'}`,
      }}
    >
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full px-3 py-2.5"
        dir="rtl"
      >
        <div className="flex items-center gap-2">
          {/* Chunk indicator */}
          <div
            className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-[9px] font-bold"
            style={{ background: `${dotColor}18`, color: dotColor, border: `1px solid ${dotColor}30` }}
          >
            {index + 1}
          </div>

          {/* Page range */}
          <span className="text-[10px] text-slate-400 flex-shrink-0">
            {chunk.pageRange || `chunk ${chunk.chunkIndex}`}
          </span>

          {/* Questions count */}
          <div className="flex-1 flex items-center justify-end gap-2">
            {chunk.retried && (
              <span className="text-[9px] rounded-full px-1.5 py-0.5" style={{ background: 'rgba(245,158,11,0.1)', color: C.gold }}>
                retry
              </span>
            )}
            {chunk.isLowConfidence && (
              <span className="text-[9px] rounded-full px-1.5 py-0.5" style={{ background: 'rgba(248,113,113,0.1)', color: C.red }}>
                OCR ضعيف
              </span>
            )}
            <span
              className="text-xs font-bold min-w-[3rem] text-left"
              style={{ color: hasQuestions ? C.green : isSkipped ? '#475569' : C.red }}
            >
              {hasQuestions ? `${chunk.extracted} ✓` : isSkipped ? 'متخطى' : '0 ✗'}
            </span>
          </div>

          {expanded
            ? <ChevronUp size={12} className="text-slate-600 flex-shrink-0" />
            : <ChevronDown size={12} className="text-slate-600 flex-shrink-0" />
          }
        </div>
      </button>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="px-3 pb-3 space-y-2 border-t border-white/5" dir="rtl">
              {/* OCR Quality */}
              <div className="pt-2">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] text-slate-500">جودة OCR</span>
                  <span className="text-[10px] text-slate-400">{chunk.chars.toLocaleString()} حرف · {chunk.arabicWords} كلمة عربية</span>
                </div>
                <OcrScoreBar score={chunk.ocrScore} />
              </div>

              {/* Dot ratio */}
              {chunk.dotRatio > 20 && (
                <div
                  className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[10px]"
                  style={{ background: 'rgba(245,158,11,0.08)', color: C.gold }}
                >
                  <AlertTriangle size={10} />
                  نسبة النقاط: {chunk.dotRatio}% — قد تكون صفحة إجابات
                </div>
              )}

              {/* Pattern detection */}
              <div className="flex flex-wrap gap-1.5">
                {[
                  { key: 'hasNumberedItems', label: 'ترقيم' },
                  { key: 'hasQuestionWords', label: 'كلمات سؤال' },
                  { key: 'hasQuestionMarks', label: '؟' },
                  { key: 'hasMcqOptions',    label: 'أ/ب/ج/د' },
                ].map(({ key, label }) => {
                  const active = chunk.patternDetail[key as keyof typeof chunk.patternDetail];
                  return (
                    <span
                      key={key}
                      className="text-[9px] rounded-full px-2 py-0.5"
                      style={{
                        background: active ? 'rgba(0,198,255,0.1)' : 'rgba(255,255,255,0.04)',
                        color: active ? C.blue : '#334155',
                        border: `1px solid ${active ? 'rgba(0,198,255,0.2)' : 'rgba(255,255,255,0.05)'}`,
                      }}
                    >
                      {label}
                    </span>
                  );
                })}
              </div>

              {/* Failure reason */}
              {chunk.failureReason && (
                <div
                  className="rounded-lg px-2.5 py-2 text-[10px] leading-relaxed"
                  style={{
                    background: isSkipped ? 'rgba(255,255,255,0.03)' : 'rgba(248,113,113,0.07)',
                    color: isSkipped ? '#475569' : '#fca5a5',
                    border: `1px solid ${isSkipped ? 'rgba(255,255,255,0.05)' : 'rgba(248,113,113,0.15)'}`,
                  }}
                >
                  {chunk.failureReason}
                </div>
              )}

              {/* Success */}
              {hasQuestions && (
                <div
                  className="flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-[10px]"
                  style={{ background: 'rgba(52,211,153,0.07)', color: C.green }}
                >
                  <CheckCircle2 size={10} />
                  تم استخراج {chunk.extracted} سؤال بنجاح{chunk.retried ? ' (بعد إعادة المحاولة)' : ''}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Summary stat card ────────────────────────────────────────────────────────
function StatCard({ label, value, color }: { label: string; value: string | number; color: string }) {
  return (
    <div
      className="flex-1 rounded-xl p-3 text-center"
      style={{ background: `${color}0d`, border: `1px solid ${color}25` }}
    >
      <div className="text-xl font-bold" style={{ color }}>{value}</div>
      <div className="text-[10px] text-slate-500 mt-0.5">{label}</div>
    </div>
  );
}

// ─── Main modal ───────────────────────────────────────────────────────────────
interface Props {
  examId: string;
  examTitle: string;
  onClose: () => void;
}

export default function ExamCoverageModal({ examId, examTitle, onClose }: Props) {
  const [report, setReport]   = useState<ExamCoverageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [filter, setFilter]   = useState<'all' | 'zero' | 'low'>('all');

  useEffect(() => {
    getExamCoverage(examId)
      .then(setReport)
      .catch((e) => setError(e instanceof Error ? e.message : 'فشل تحميل التقرير'))
      .finally(() => setLoading(false));
  }, [examId]);

  const filteredChunks = report?.chunks.filter((c) => {
    if (filter === 'zero') return c.extracted === 0 && c.failureReason !== null && !c.failureReason.includes('تم التخطي');
    if (filter === 'low')  return c.isLowConfidence;
    return true;
  }) ?? [];

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-end justify-center"
      style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(6px)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <motion.div
        initial={{ y: '100%' }}
        animate={{ y: 0 }}
        exit={{ y: '100%' }}
        transition={{ type: 'spring', damping: 28, stiffness: 320 }}
        className="w-full max-w-[430px] rounded-t-3xl overflow-hidden flex flex-col"
        style={{ background: '#0d1426', border: '1px solid rgba(255,255,255,0.07)', maxHeight: '92vh' }}
      >
        {/* Handle */}
        <div className="flex justify-center pt-3 pb-1 flex-shrink-0">
          <div className="w-10 h-1 rounded-full" style={{ background: 'rgba(255,255,255,0.15)' }} />
        </div>

        {/* Header */}
        <div className="px-4 pb-3 flex items-center justify-between flex-shrink-0" dir="rtl">
          <div className="flex items-center gap-2">
            <div
              className="flex h-8 w-8 items-center justify-center rounded-xl"
              style={{ background: 'rgba(0,198,255,0.1)', border: '1px solid rgba(0,198,255,0.2)' }}
            >
              <BarChart3 size={15} style={{ color: C.blue }} />
            </div>
            <div>
              <h2 className="text-sm font-bold text-white">تحليل التغطية</h2>
              <p className="text-[10px] text-slate-500 leading-tight truncate max-w-[220px]">{examTitle}</p>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-600 hover:text-slate-400 p-1">
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-4 pb-6 min-h-0">
          {loading && (
            <div className="flex flex-col items-center justify-center py-16 gap-3" dir="rtl">
              <div className="flex gap-1.5">
                {[0,1,2].map((i) => (
                  <div key={i} className="h-2 w-2 rounded-full animate-pulse" style={{ background: C.blue, animationDelay: `${i * 0.2}s` }} />
                ))}
              </div>
              <p className="text-xs text-slate-500">جاري تحليل التغطية…</p>
            </div>
          )}

          {error && (
            <div className="rounded-xl p-4 text-center text-xs mt-4" style={{ background: 'rgba(248,113,113,0.1)', color: C.red }}>
              {error}
            </div>
          )}

          {report && !loading && (
            <div dir="rtl">
              {/* Summary stats */}
              <div className="flex gap-2 mb-4">
                <StatCard label="إجمالي مُستخرج" value={report.totalExtracted} color={C.green} />
                <StatCard label="أجزاء بدون أسئلة" value={report.zeroChunkCount} color={report.zeroChunkCount > 0 ? C.red : C.green} />
                <StatCard label="جودة OCR" value={report.ocrQualityScore !== null ? `${report.ocrQualityScore}%` : 'N/A'} color={
                  report.ocrQualityScore === null ? '#475569'
                  : report.ocrQualityScore >= 60 ? C.green
                  : report.ocrQualityScore >= 35 ? C.gold : C.red
                } />
              </div>

              {/* Failure reason banner */}
              {report.failureReason && (
                <div
                  className="mb-4 rounded-xl p-3 text-[11px] leading-relaxed flex gap-2"
                  style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.15)', color: '#fca5a5' }}
                >
                  <AlertTriangle size={13} className="flex-shrink-0 mt-0.5" style={{ color: C.red }} />
                  <span>{report.failureReason}</span>
                </div>
              )}

              {/* Meta info */}
              <div
                className="mb-4 rounded-xl p-3 text-[11px] space-y-1"
                style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}
              >
                <div className="flex justify-between">
                  <span className="text-slate-500">إجمالي الأجزاء</span>
                  <span className="text-white font-medium">{report.totalChunks}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">أجزاء تمت معالجتها</span>
                  <span className="text-white font-medium">{report.chunksAttempted}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">أجزاء بثقة OCR منخفضة</span>
                  <span style={{ color: report.lowConfChunkCount > 0 ? C.orange : C.green }}>{report.lowConfChunkCount}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">الأسئلة المُستخرجة النهائية</span>
                  <span className="font-bold" style={{ color: C.green }}>{report.questionCount}</span>
                </div>
              </div>

              {/* Filter pills */}
              <div className="flex gap-2 mb-3">
                {([
                  { key: 'all',  label: `الكل (${report.totalChunks})` },
                  { key: 'zero', label: `صفر أسئلة (${report.zeroChunkCount})` },
                  { key: 'low',  label: `OCR ضعيف (${report.lowConfChunkCount})` },
                ] as const).map(({ key, label }) => (
                  <button
                    key={key}
                    onClick={() => setFilter(key)}
                    className="rounded-full px-3 py-1 text-[10px] font-semibold transition-all"
                    style={{
                      background: filter === key ? 'rgba(0,198,255,0.15)' : 'rgba(255,255,255,0.04)',
                      border: filter === key ? '1px solid rgba(0,198,255,0.3)' : '1px solid rgba(255,255,255,0.07)',
                      color: filter === key ? C.blue : '#64748b',
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {/* Per-chunk breakdown */}
              {filteredChunks.length === 0 ? (
                <div className="py-8 text-center">
                  <FileText size={28} className="mx-auto mb-2 text-slate-700" />
                  <p className="text-xs text-slate-500">لا توجد أجزاء تطابق الفلتر المحدد</p>
                </div>
              ) : (
                <div>
                  <p className="text-[10px] text-slate-600 mb-2">
                    {filteredChunks.length} جزء — انقر لعرض التفاصيل
                  </p>
                  {filteredChunks.map((chunk, i) => (
                    <ChunkRow key={chunk.chunkIndex} chunk={chunk} index={i} />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}
