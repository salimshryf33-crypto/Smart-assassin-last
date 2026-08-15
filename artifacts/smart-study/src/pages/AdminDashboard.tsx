import { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Shield, Activity, Database, HardDrive, Clock, Brain,
  RefreshCw, ChevronLeft, CheckCircle, XCircle, AlertCircle,
  Server, Cpu, MemoryStick, FileArchive, Eye, EyeOff,
  Search, FileText, BarChart2, Zap,
  Link2, ThumbsUp, ThumbsDown, RotateCcw, BookOpen,
  Layers, ListChecks, Cpu as CpuIcon, Inbox, TrendingUp,
  ArrowRight, GitCommitVertical, Zap as ZapIcon,
} from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import PageWrapper from '../components/layout/PageWrapper';
import {
  fetchSystemHealth, fetchAuditLog, triggerBackup,
  fetchMetrics, fetchUsageSummary, fetchCacheMetrics,
  fetchPrepOps,
  type SystemHealth, type AuditEntry,
  type MetricsSnapshot, type UsageSummary, type CacheMetrics,
  type PrepOpsDashboard,
  type PrepOpsSchedulerState,
} from '../utils/adminApi';
import {
  fetchPendingLinks, fetchLinkStats, fetchAllLinks,
  approveCurriculumLink, rejectCurriculumLink, rematchCurriculumLink,
  rematchAllNoMatch,
  type CurriculumLink, type LinkStats,
} from '../utils/curriculumLinksApi';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatTS(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ar-EG', { dateStyle: 'short', timeStyle: 'short' });
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `منذ ${s}ث`;
  const m = Math.floor(s / 60);
  if (m < 60) return `منذ ${m}د`;
  const h = Math.floor(m / 60);
  if (h < 24) return `منذ ${h}س`;
  return `منذ ${Math.floor(h / 24)}ي`;
}

const ACTION_LABELS: Record<string, string> = {
  admin_claim_set: 'تعيين صلاحية أدمن',
  role_grant:      'منح دور',
  role_revoke:     'سحب دور',
  backup_run:      'تشغيل نسخ احتياطي',
  cache_clear:     'مسح الكاش',
  extraction_trigger: 'استخراج أسئلة',
};

// ─── Shared Sub-components ────────────────────────────────────────────────────

function StatusBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold"
      style={{
        background: ok ? 'rgba(52,211,153,0.12)' : 'rgba(248,113,113,0.12)',
        border: `1px solid ${ok ? 'rgba(52,211,153,0.3)' : 'rgba(248,113,113,0.3)'}`,
        color: ok ? '#34d399' : '#f87171',
      }}
    >
      {ok ? <CheckCircle size={9} /> : <XCircle size={9} />}
      {label}
    </span>
  );
}

function GlassPanel({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-2xl p-4 ${className}`}
      style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}
    >
      {children}
    </div>
  );
}

function SectionTitle({ icon: Icon, title, color = '#00c6ff' }: { icon: typeof Shield; title: string; color?: string }) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <div className="flex h-7 w-7 items-center justify-center rounded-xl"
        style={{ background: `${color}18`, border: `1px solid ${color}30` }}
      >
        <Icon size={14} style={{ color }} strokeWidth={2} />
      </div>
      <span className="text-sm font-semibold text-white" dir="rtl">{title}</span>
    </div>
  );
}

function KpiRow({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-xs text-slate-400" dir="rtl">{label}</span>
      <div className="text-right" dir="rtl">
        <span className="text-xs font-bold text-white">{value}</span>
        {sub && <span className="block text-[10px] text-slate-500">{sub}</span>}
      </div>
    </div>
  );
}

// ─── Health Section ───────────────────────────────────────────────────────────

function HealthSection({ health }: { health: SystemHealth }) {
  const { server, database, security } = health;
  const isHealthy = health.status === 'healthy';
  return (
    <div className="space-y-3">
      <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }}
        className="flex items-center gap-3 rounded-2xl p-3"
        style={{
          background: isHealthy ? 'rgba(52,211,153,0.07)' : 'rgba(251,191,36,0.07)',
          border: `1px solid ${isHealthy ? 'rgba(52,211,153,0.2)' : 'rgba(251,191,36,0.2)'}`,
        }}
      >
        {isHealthy ? <CheckCircle size={18} className="text-emerald-400 flex-shrink-0" /> : <AlertCircle size={18} className="text-amber-400 flex-shrink-0" />}
        <div dir="rtl">
          <p className="text-sm font-semibold" style={{ color: isHealthy ? '#34d399' : '#fbbf24' }}>
            {isHealthy ? 'النظام يعمل بشكل طبيعي' : 'النظام يعمل مع تحذيرات'}
          </p>
          <p className="text-[10px] text-slate-500">{formatTS(health.timestamp)}</p>
        </div>
      </motion.div>

      <GlassPanel>
        <SectionTitle icon={Server} title="معلومات السيرفر" />
        <div className="grid grid-cols-2 gap-2" dir="rtl">
          {[
            { icon: Clock, color: '#00c6ff', label: 'وقت التشغيل', value: formatUptime(server.uptimeSeconds) },
            { icon: Cpu, color: '#a78bfa', label: 'معالجات', value: `${server.cpus} cores` },
            { icon: MemoryStick, color: '#f59e0b', label: 'RAM المستخدمة', value: `${server.memory.heapUsedMB} MB` },
            { icon: Activity, color: '#34d399', label: 'Node.js', value: server.nodeVersion },
          ].map(({ icon: Icon, color, label, value }) => (
            <div key={label} className="flex items-center gap-2 rounded-xl bg-white/[0.03] p-2.5">
              <Icon size={13} style={{ color }} />
              <div>
                <p className="text-[10px] text-slate-500">{label}</p>
                <p className="text-xs font-bold text-white">{value}</p>
              </div>
            </div>
          ))}
        </div>
      </GlassPanel>

      <GlassPanel>
        <SectionTitle icon={Database} title="قاعدة البيانات" color="#a78bfa" />
        <div className="space-y-1" dir="rtl">
          <KpiRow label="الاتصال" value={<StatusBadge ok={database.connected} label={database.connected ? 'متصل' : 'غير متصل'} />} />
          <KpiRow label="سجلات التدقيق" value={database.auditEntries.toLocaleString('ar')} />
          <KpiRow label="الأدوار المعيّنة" value={database.assignedRoles} />
          <KpiRow label="وقت السيرفر" value={formatTS(database.serverTime)} />
        </div>
      </GlassPanel>

      <GlassPanel>
        <SectionTitle icon={Shield} title="ميزات الأمان" color="#34d399" />
        <div className="grid grid-cols-2 gap-1.5" dir="rtl">
          {Object.entries(security).map(([key, enabled]) => {
            const labels: Record<string, string> = {
              rateLimitingEnabled:    'تحديد الطلبات',
              pdfValidationEnabled:   'التحقق من PDF',
              rbacEnabled:            'صلاحيات RBAC',
              auditLogEnabled:        'سجل التدقيق',
              securityHeadersEnabled: 'Security Headers',
            };
            return (
              <div key={key} className="flex items-center gap-1.5 rounded-xl bg-white/[0.03] px-2.5 py-2">
                {enabled ? <CheckCircle size={11} className="text-emerald-400 flex-shrink-0" /> : <XCircle size={11} className="text-red-400 flex-shrink-0" />}
                <span className="text-[11px] text-slate-300 leading-tight">{labels[key] ?? key}</span>
              </div>
            );
          })}
        </div>
      </GlassPanel>
    </div>
  );
}

// ─── Backup Section ───────────────────────────────────────────────────────────

function BackupSection({ backup, onTrigger, triggering }: {
  backup: SystemHealth['backup']; onTrigger: () => void; triggering: boolean;
}) {
  return (
    <GlassPanel>
      <div className="flex items-center justify-between mb-3">
        <SectionTitle icon={HardDrive} title="النسخ الاحتياطي" color="#f59e0b" />
        <motion.button whileTap={{ scale: 0.92 }} onClick={onTrigger} disabled={triggering}
          className="flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-[11px] font-semibold"
          style={{ background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.25)', color: '#f59e0b', opacity: triggering ? 0.5 : 1 }}
        >
          <FileArchive size={11} />
          {triggering ? 'جارٍ...' : 'نسخ الآن'}
        </motion.button>
      </div>
      <div className="space-y-1" dir="rtl">
        <KpiRow label="آخر نسخة" value={formatTS(backup.lastRun)} />
        <KpiRow label="الحالة" value={
          backup.lastStatus
            ? <StatusBadge ok={backup.lastStatus === 'success'} label={backup.lastStatus === 'success' ? 'ناجحة' : backup.lastStatus} />
            : <span className="text-xs text-slate-500">لا توجد نسخة بعد</span>
        } />
        <KpiRow label="الحجم" value={backup.lastSizeKB ? `${(backup.lastSizeKB / 1024).toFixed(1)} MB` : '—'} />
        <KpiRow label="إجمالي النسخ" value={backup.totalRuns} />
      </div>
    </GlassPanel>
  );
}

// ─── Audit Log Section ────────────────────────────────────────────────────────

function AuditLogSection({ entries }: { entries: AuditEntry[] }) {
  const [showIds, setShowIds] = useState(false);
  if (entries.length === 0) {
    return (
      <GlassPanel>
        <SectionTitle icon={Eye} title="سجل التدقيق" color="#60a5fa" />
        <p className="text-center text-xs text-slate-500 py-4" dir="rtl">لا توجد إجراءات مسجّلة بعد</p>
      </GlassPanel>
    );
  }
  return (
    <GlassPanel>
      <div className="flex items-center justify-between mb-3">
        <SectionTitle icon={Eye} title={`سجل التدقيق (${entries.length})`} color="#60a5fa" />
        <button onClick={() => setShowIds(v => !v)} className="text-[10px] text-slate-500 flex items-center gap-1">
          {showIds ? <EyeOff size={11} /> : <Eye size={11} />}
          {showIds ? 'إخفاء IDs' : 'إظهار IDs'}
        </button>
      </div>
      <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
        <AnimatePresence initial={false}>
          {entries.map((entry) => (
            <motion.div key={entry.id} initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }}
              className="rounded-xl p-2.5"
              style={{ background: 'rgba(96,165,250,0.05)', border: '1px solid rgba(96,165,250,0.1)' }}
            >
              <div className="flex items-start justify-between gap-2" dir="rtl">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-white truncate">{ACTION_LABELS[entry.action] ?? entry.action}</p>
                  {entry.resource_type && (
                    <p className="text-[10px] text-slate-400 mt-0.5">
                      {entry.resource_type}{entry.resource_id ? `: ${entry.resource_id.slice(0, 12)}…` : ''}
                    </p>
                  )}
                  {showIds && entry.uid && <p className="text-[9px] text-slate-600 mt-0.5 font-mono">{entry.uid.slice(0, 20)}…</p>}
                </div>
                <span className="text-[10px] text-slate-500 flex-shrink-0">{timeAgo(entry.created_at)}</span>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </GlassPanel>
  );
}

// ─── Metrics Section ──────────────────────────────────────────────────────────

function MetricBar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max === 0 ? 0 : Math.min(100, Math.round((value / max) * 100));
  return (
    <div className="h-1.5 w-full rounded-full bg-white/[0.06] overflow-hidden">
      <motion.div
        className="h-full rounded-full"
        style={{ background: color }}
        initial={{ width: 0 }}
        animate={{ width: `${pct}%` }}
        transition={{ duration: 0.6, ease: 'easeOut' }}
      />
    </div>
  );
}

function MetricsSection({
  metrics, usage, cache,
}: {
  metrics: MetricsSnapshot | null;
  usage: UsageSummary | null;
  cache: CacheMetrics | null;
}) {
  if (!metrics && !usage && !cache) {
    return (
      <p className="text-center text-xs text-slate-500 py-8" dir="rtl">جارٍ تحميل المقاييس…</p>
    );
  }

  return (
    <div className="space-y-3">

      {/* ── Gemini AI ─────────────────────────────────────────────────────── */}
      {metrics && (
        <GlassPanel>
          <SectionTitle icon={Brain} title="مكالمات Gemini AI" color="#a78bfa" />
          <div className="space-y-1" dir="rtl">
            <KpiRow label="اليوم" value={
              <span className="text-lg font-black" style={{ color: '#a78bfa' }}>
                {metrics.gemini.callsToday.toLocaleString('ar')}
              </span>
            } />
            <KpiRow label="الإجمالي" value={metrics.gemini.callsTotal.toLocaleString('ar')} />
            <KpiRow label="الفشل" value={
              <span style={{ color: metrics.gemini.failures > 0 ? '#f87171' : '#34d399' }}>
                {metrics.gemini.failures}
              </span>
            } />
            <KpiRow label="أخطاء الـ Quota" value={
              <span style={{ color: metrics.gemini.quotaErrors > 0 ? '#fbbf24' : '#34d399' }}>
                {metrics.gemini.quotaErrors}
              </span>
            } />
            <KpiRow label="متوسط الاستجابة" value={
              metrics.gemini.avgResponseMs > 0 ? `${metrics.gemini.avgResponseMs} ms` : '—'
            } />
            <div className="pt-1">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] text-slate-500">معدل النجاح</span>
                <span className="text-[10px] font-semibold" style={{ color: metrics.gemini.successRate >= 90 ? '#34d399' : '#fbbf24' }}>
                  {metrics.gemini.successRate}%
                </span>
              </div>
              <MetricBar value={metrics.gemini.successRate} max={100} color={metrics.gemini.successRate >= 90 ? '#34d399' : '#fbbf24'} />
            </div>
          </div>
        </GlassPanel>
      )}

      {/* ── Search ────────────────────────────────────────────────────────── */}
      {metrics && (
        <GlassPanel>
          <SectionTitle icon={Search} title="البحث في المناهج" color="#00c6ff" />
          <div className="space-y-1" dir="rtl">
            <KpiRow label="إجمالي البحثات" value={
              <span className="text-lg font-black" style={{ color: '#00c6ff' }}>
                {metrics.search.total.toLocaleString('ar')}
              </span>
            } />
            <KpiRow label="متوسط الاستجابة" value={
              metrics.search.avgLatencyMs > 0 ? `${metrics.search.avgLatencyMs} ms` : '—'
            } />
          </div>

          {metrics.search.topSubjects.length > 0 && (
            <div className="mt-3" dir="rtl">
              <p className="text-[10px] text-slate-500 mb-2">أكثر المواد بحثاً</p>
              <div className="space-y-2">
                {metrics.search.topSubjects.map((s, i) => {
                  const maxCount = metrics.search.topSubjects[0]?.count ?? 1;
                  return (
                    <div key={s.name}>
                      <div className="flex items-center justify-between mb-0.5">
                        <span className="text-[11px] text-slate-300 truncate max-w-[70%]">{s.name}</span>
                        <span className="text-[10px] text-slate-500">{s.count}</span>
                      </div>
                      <MetricBar value={s.count} max={maxCount}
                        color={['#00c6ff','#a78bfa','#34d399','#f59e0b','#f87171'][i % 5]!}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </GlassPanel>
      )}

      {/* ── OCR & Storage ─────────────────────────────────────────────────── */}
      {usage && (
        <GlassPanel>
          <SectionTitle icon={FileText} title="الكتب والـ OCR" color="#34d399" />
          <div className="space-y-1" dir="rtl">
            <KpiRow label="إجمالي المستندات" value={usage.curriculum.totalDocs} />
            <KpiRow label="كتب" value={usage.curriculum.books} />
            <KpiRow label="امتحانات" value={usage.curriculum.examDocs} />
            <KpiRow label="Chunks معالجة" value={usage.curriculum.totalChunks.toLocaleString('ar')} />
          </div>
          <div className="mt-3 grid grid-cols-3 gap-1.5" dir="rtl">
            {[
              { label: 'مكتمل', value: usage.ocr.done, color: '#34d399' },
              { label: 'يعالج', value: usage.ocr.processing, color: '#fbbf24' },
              { label: 'فشل', value: usage.ocr.failed, color: '#f87171' },
            ].map(({ label, value, color }) => (
              <div key={label} className="flex flex-col items-center rounded-xl py-2.5"
                style={{ background: `${color}09`, border: `1px solid ${color}22` }}
              >
                <span className="text-base font-black" style={{ color }}>{value}</span>
                <span className="text-[9px] text-slate-500 mt-0.5">{label}</span>
              </div>
            ))}
          </div>

          <div className="mt-3 pt-3 border-t border-white/[0.05] space-y-1" dir="rtl">
            <KpiRow label="ملفات PDF" value={usage.storage.pdfCount} />
            <KpiRow label="حجم التخزين" value={`${usage.storage.pdfSizeMB} MB`} />
          </div>
        </GlassPanel>
      )}

      {/* ── Exams ─────────────────────────────────────────────────────────── */}
      {usage && (
        <GlassPanel>
          <SectionTitle icon={BarChart2} title="الامتحانات والأسئلة" color="#f59e0b" />
          <div className="space-y-1" dir="rtl">
            <KpiRow label="أسئلة مستخرجة" value={
              <span className="text-lg font-black" style={{ color: '#f59e0b' }}>
                {usage.exams.questionsExtracted.toLocaleString('ar')}
              </span>
            } />
            <KpiRow label="امتحانات مكتملة" value={usage.exams.totalDone} />
            <KpiRow label="في الانتظار" value={usage.exams.totalPending} />
            <KpiRow label="فشلت" value={
              <span style={{ color: usage.exams.totalError > 0 ? '#f87171' : '#34d399' }}>
                {usage.exams.totalError}
              </span>
            } />
          </div>
        </GlassPanel>
      )}

      {/* ── Cache ─────────────────────────────────────────────────────────── */}
      {cache && (
        <GlassPanel>
          <SectionTitle icon={Zap} title="الكاش" color="#60a5fa" />
          <div className="space-y-1" dir="rtl">
            <KpiRow label="الـ Backend" value={
              <StatusBadge ok={cache.connected} label={cache.backend} />
            } />
            <KpiRow label="Hit / Miss" value={`${cache.hits} / ${cache.misses}`} />
            <KpiRow label="نسبة الإصابة" value={`${cache.hitRatioPct}%`} />
            <KpiRow label="مكالمات Gemini موفَّرة" value={
              <span style={{ color: '#34d399' }}>{cache.savedGeminiCalls}</span>
            } />
          </div>
          <div className="mt-3">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10px] text-slate-500">Cache Hit Ratio</span>
              <span className="text-[10px] font-semibold" style={{ color: cache.hitRatioPct >= 50 ? '#34d399' : '#fbbf24' }}>
                {cache.hitRatioPct}%
              </span>
            </div>
            <MetricBar value={cache.hitRatioPct} max={100} color={cache.hitRatioPct >= 50 ? '#34d399' : '#60a5fa'} />
          </div>
        </GlassPanel>
      )}

      {/* ── Request counters ──────────────────────────────────────────────── */}
      {metrics && (
        <GlassPanel>
          <SectionTitle icon={Activity} title="الطلبات" color="#94a3b8" />
          <div className="grid grid-cols-3 gap-1.5" dir="rtl">
            {[
              { label: 'الإجمالي', value: metrics.requests.total, color: '#94a3b8' },
              { label: 'نشطة الآن', value: metrics.requests.active, color: '#00c6ff' },
              { label: 'أخطاء', value: metrics.requests.errors, color: metrics.requests.errors > 0 ? '#f87171' : '#34d399' },
            ].map(({ label, value, color }) => (
              <div key={label} className="flex flex-col items-center rounded-xl py-2.5"
                style={{ background: `${color}09`, border: `1px solid ${color}22` }}
              >
                <span className="text-base font-black" style={{ color }}>{value}</span>
                <span className="text-[9px] text-slate-500 mt-0.5 text-center">{label}</span>
              </div>
            ))}
          </div>
        </GlassPanel>
      )}

    </div>
  );
}

// ─── Quick Stats Bar ──────────────────────────────────────────────────────────

function QuickStats({ health, metrics }: { health: SystemHealth; metrics: MetricsSnapshot | null }) {
  const stats = [
    { label: 'وقت التشغيل', value: formatUptime(health.server.uptimeSeconds), color: '#00c6ff' },
    { label: 'Gemini اليوم', value: metrics?.gemini.callsToday ?? '…', color: '#a78bfa' },
    { label: 'RAM MB', value: health.server.memory.heapUsedMB, color: '#f59e0b' },
    { label: 'بحثات', value: metrics?.search.total ?? '…', color: '#34d399' },
  ];
  return (
    <div className="grid grid-cols-4 gap-2 mb-4">
      {stats.map((s) => (
        <motion.div key={s.label} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
          className="flex flex-col items-center rounded-2xl py-3 px-1"
          style={{ background: `${s.color}09`, border: `1px solid ${s.color}22` }}
        >
          <span className="text-sm font-bold text-white">{s.value}</span>
          <span className="text-[9px] text-slate-500 mt-0.5 text-center leading-tight" dir="rtl">{s.label}</span>
        </motion.div>
      ))}
    </div>
  );
}

// ─── Curriculum Links Section ─────────────────────────────────────────────────

const STATUS_LABELS: Record<string, string> = {
  pending_review: 'بانتظار المراجعة',
  approved:       'مُعتمد',
  rejected:       'مرفوض',
  no_match:       'لا تطابق',
};

const STATUS_COLORS: Record<string, string> = {
  pending_review: '#f59e0b',
  approved:       '#34d399',
  rejected:       '#f87171',
  no_match:       '#64748b',
};

function ConfidenceRing({ value }: { value: number }) {
  const r   = 22;
  const circ = 2 * Math.PI * r;
  const dash = (value / 100) * circ;
  const color = value >= 90 ? '#34d399' : value >= 50 ? '#f59e0b' : '#f87171';
  return (
    <svg width={56} height={56} className="flex-shrink-0" style={{ transform: 'rotate(-90deg)' }}>
      <circle cx={28} cy={28} r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={5} />
      <circle cx={28} cy={28} r={r} fill="none" stroke={color} strokeWidth={5}
        strokeDasharray={`${dash} ${circ - dash}`} strokeLinecap="round"
        style={{ transition: 'stroke-dasharray 0.6s ease' }}
      />
      <text x={28} y={28} textAnchor="middle" dominantBaseline="central"
        style={{ fill: color, fontSize: 11, fontWeight: 700, transform: 'rotate(90deg)', transformOrigin: '28px 28px' }}
      >
        {Math.round(value)}%
      </text>
    </svg>
  );
}

function ComponentBar({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="flex items-center gap-1.5" dir="rtl">
      <span className="w-16 text-[9px] text-slate-500 text-right">{label}</span>
      <div className="flex-1 h-1.5 rounded-full" style={{ background: 'rgba(255,255,255,0.06)' }}>
        <div className="h-1.5 rounded-full transition-all duration-500"
          style={{ width: `${Math.min(value, 100)}%`, background: color }} />
      </div>
      <span className="w-6 text-right text-[9px]" style={{ color }}>{Math.round(value)}</span>
    </div>
  );
}

function LinkCard({
  link,
  onApprove,
  onReject,
  onRematch,
  busy,
}: {
  link:      CurriculumLink;
  onApprove: (l: CurriculumLink) => void;
  onReject:  (l: CurriculumLink) => void;
  onRematch: (l: CurriculumLink) => void;
  busy:      string | null;
}) {
  const isBusy  = busy === link.examId;
  const conf    = link.confidenceScore ?? 0;
  const comps   = link.matchMetadata?.components;
  const title   = link.matchMetadata?.candidateTitle ?? link.curriculumDocId ?? '—';
  const color   = STATUS_COLORS[link.status] ?? '#64748b';

  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
      className="rounded-2xl p-3 space-y-2.5"
      style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}
    >
      {/* Header */}
      <div className="flex items-start gap-2.5" dir="rtl">
        <ConfidenceRing value={conf} />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-white truncate">{link.examTitle || link.examId}</p>
          <div className="flex items-center gap-1 mt-0.5">
            <BookOpen size={9} style={{ color: '#00c6ff' }} />
            <p className="text-[10px] text-slate-400 truncate">{title}</p>
          </div>
          <div className="flex items-center gap-1.5 mt-1">
            <span className="text-[9px] font-medium rounded-full px-1.5 py-px"
              style={{ background: `${color}18`, border: `1px solid ${color}30`, color }}
            >
              {STATUS_LABELS[link.status] ?? link.status}
            </span>
            <span className="text-[9px] text-slate-600">
              {link.linkType === 'auto' ? 'آلي' : 'يدوي'}
            </span>
          </div>
        </div>
      </div>

      {/* Component breakdown */}
      {comps && (
        <div className="space-y-1 px-0.5">
          <ComponentBar label="البيانات الوصفية" value={comps.metadata}  color="#00c6ff" />
          <ComponentBar label="الكلمات المفتاحية"  value={comps.keywords}  color="#a78bfa" />
          <ComponentBar label="الفصول"           value={comps.chapters}  color="#34d399" />
          <ComponentBar label="التسلسل الزمني"    value={comps.temporal}  color="#f59e0b" />
        </div>
      )}

      {/* Action buttons */}
      {(link.status === 'pending_review') && (
        <div className="flex gap-1.5">
          <motion.button whileTap={{ scale: 0.93 }} disabled={isBusy}
            onClick={() => onApprove(link)}
            className="flex flex-1 items-center justify-center gap-1 rounded-xl py-1.5 text-[10px] font-semibold transition-opacity"
            style={{ background: 'rgba(52,211,153,0.12)', border: '1px solid rgba(52,211,153,0.25)', color: '#34d399', opacity: isBusy ? 0.5 : 1 }}
          >
            <ThumbsUp size={10} />
            <span dir="rtl">اعتماد</span>
          </motion.button>
          <motion.button whileTap={{ scale: 0.93 }} disabled={isBusy}
            onClick={() => onReject(link)}
            className="flex flex-1 items-center justify-center gap-1 rounded-xl py-1.5 text-[10px] font-semibold transition-opacity"
            style={{ background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.22)', color: '#f87171', opacity: isBusy ? 0.5 : 1 }}
          >
            <ThumbsDown size={10} />
            <span dir="rtl">رفض</span>
          </motion.button>
          <motion.button whileTap={{ scale: 0.93 }} disabled={isBusy}
            onClick={() => onRematch(link)}
            className="flex items-center justify-center gap-1 rounded-xl px-2.5 py-1.5 text-[10px] font-semibold transition-opacity"
            style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#94a3b8', opacity: isBusy ? 0.5 : 1 }}
          >
            <RotateCcw size={10} className={isBusy ? 'animate-spin' : ''} />
          </motion.button>
        </div>
      )}
      {link.status !== 'pending_review' && (
        <motion.button whileTap={{ scale: 0.93 }} disabled={isBusy}
          onClick={() => onRematch(link)}
          className="flex w-full items-center justify-center gap-1 rounded-xl py-1.5 text-[10px] font-semibold transition-opacity"
          style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: '#64748b', opacity: isBusy ? 0.5 : 1 }}
        >
          <RotateCcw size={10} className={isBusy ? 'animate-spin' : ''} />
          <span dir="rtl">إعادة المطابقة</span>
        </motion.button>
      )}
    </motion.div>
  );
}

function CurriculumLinksSection() {
  const [stats,        setStats]        = useState<LinkStats | null>(null);
  const [links,        setLinks]        = useState<CurriculumLink[]>([]);
  const [filter,       setFilter]       = useState<'pending_review' | 'approved' | 'all'>('pending_review');
  const [loading,      setLoading]      = useState(true);
  const [busy,         setBusy]         = useState<string | null>(null);
  const [rematchingAll, setRematchingAll] = useState(false);
  const [msg,          setMsg]          = useState<{ text: string; ok: boolean } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, l] = await Promise.all([
        fetchLinkStats(),
        filter === 'all' ? fetchAllLinks(undefined, 100) : fetchAllLinks(filter, 100),
      ]);
      setStats(s);
      setLinks(l);
    } catch (e) {
      setMsg({ text: String(e), ok: false });
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => { load(); }, [load]);

  const flash = (text: string, ok: boolean) => {
    setMsg({ text, ok });
    setTimeout(() => setMsg(null), 3500);
  };

  const handleApprove = async (link: CurriculumLink) => {
    setBusy(link.examId);
    try {
      await approveCurriculumLink(link.examId);
      flash('تم الاعتماد بنجاح ✓', true);
      await load();
    } catch (e) {
      flash(String(e), false);
    } finally {
      setBusy(null);
    }
  };

  const handleReject = async (link: CurriculumLink) => {
    setBusy(link.examId);
    try {
      await rejectCurriculumLink(link.examId);
      flash('تم الرفض — تجري إعادة المطابقة', true);
      await load();
    } catch (e) {
      flash(String(e), false);
    } finally {
      setBusy(null);
    }
  };

  const handleRematch = async (link: CurriculumLink) => {
    setBusy(link.examId);
    try {
      await rematchCurriculumLink(link.examId);
      flash('جارٍ إعادة المطابقة في الخلفية…', true);
      setTimeout(load, 3000);
    } catch (e) {
      flash(String(e), false);
    } finally {
      setBusy(null);
    }
  };

  const handleRematchAll = async () => {
    setRematchingAll(true);
    try {
      await rematchAllNoMatch();
      flash('تمت إعادة مطابقة الكل — تحقق بعد لحظات', true);
      setTimeout(load, 5000);
    } catch (e) {
      flash(String(e), false);
    } finally {
      setRematchingAll(false);
    }
  };

  return (
    <div className="space-y-3">
      <SectionTitle icon={Link2} title="ربط الامتحانات بالمناهج" color="#a78bfa" />

      {/* Stats row */}
      {stats && (
        <div className="grid grid-cols-4 gap-2" dir="rtl">
          {[
            { label: 'انتظار',  value: stats.pending,  color: '#f59e0b' },
            { label: 'معتمد',   value: stats.approved, color: '#34d399' },
            { label: 'مرفوض',   value: stats.rejected, color: '#f87171' },
            { label: 'لا تطابق', value: stats.no_match, color: '#64748b' },
          ].map(({ label, value, color }) => (
            <div key={label} className="flex flex-col items-center justify-center rounded-xl py-2.5"
              style={{ background: `${color}0d`, border: `1px solid ${color}25` }}
            >
              <span className="text-base font-bold" style={{ color }}>{value}</span>
              <span className="text-[9px] text-slate-500">{label}</span>
            </div>
          ))}
        </div>
      )}

      {/* Filter pills */}
      <div className="flex gap-1.5" dir="rtl">
        {([
          { id: 'pending_review' as const, label: 'بانتظار المراجعة' },
          { id: 'approved'       as const, label: 'المعتمدة'         },
          { id: 'all'            as const, label: 'الكل'             },
        ] as const).map(({ id, label }) => (
          <button key={id} onClick={() => setFilter(id)}
            className="rounded-xl px-2.5 py-1 text-[10px] font-semibold transition-all"
            style={{
              background: filter === id ? 'rgba(167,139,250,0.15)' : 'rgba(255,255,255,0.04)',
              border:     filter === id ? '1px solid rgba(167,139,250,0.3)' : '1px solid rgba(255,255,255,0.07)',
              color:      filter === id ? '#a78bfa' : '#64748b',
            }}
          >
            {label}
          </button>
        ))}
        <motion.button whileTap={{ scale: 0.93 }} onClick={load}
          className="rounded-xl px-2.5 py-1 text-[10px] font-semibold"
          style={{ background: 'rgba(0,198,255,0.08)', border: '1px solid rgba(0,198,255,0.18)', color: '#00c6ff' }}
        >
          <RefreshCw size={10} />
        </motion.button>
        <motion.button whileTap={{ scale: 0.93 }} onClick={handleRematchAll}
          disabled={rematchingAll}
          className="flex items-center gap-1 rounded-xl px-2.5 py-1 text-[10px] font-semibold transition-opacity"
          style={{ background: 'rgba(167,139,250,0.1)', border: '1px solid rgba(167,139,250,0.22)', color: '#a78bfa', opacity: rematchingAll ? 0.5 : 1 }}
          dir="rtl"
        >
          <RotateCcw size={10} className={rematchingAll ? 'animate-spin' : ''} />
          إعادة مطابقة الكل
        </motion.button>
      </div>

      {/* Feedback toast */}
      <AnimatePresence>
        {msg && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
            className="rounded-xl px-3 py-2 text-xs text-center"
            style={{
              background: msg.ok ? 'rgba(52,211,153,0.1)' : 'rgba(248,113,113,0.1)',
              border: `1px solid ${msg.ok ? 'rgba(52,211,153,0.25)' : 'rgba(248,113,113,0.25)'}`,
              color: msg.ok ? '#34d399' : '#f87171',
            }}
            dir="rtl"
          >
            {msg.text}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Link cards */}
      {loading ? (
        <div className="flex justify-center py-10">
          <div className="flex gap-1.5">
            {[0,1,2].map(i => (
              <div key={i} className="h-1.5 w-1.5 rounded-full bg-[#a78bfa] animate-pulse"
                style={{ animationDelay: `${i * 0.2}s` }} />
            ))}
          </div>
        </div>
      ) : links.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-12" dir="rtl">
          <CheckCircle size={28} className="text-emerald-400" />
          <p className="text-sm font-semibold text-emerald-400">لا توجد عناصر بانتظار المراجعة</p>
          <p className="text-[10px] text-slate-500">جميع الامتحانات مربوطة بمناهجها</p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {links.map(link => (
            <LinkCard key={link.id} link={link}
              onApprove={handleApprove}
              onReject={handleReject}
              onRematch={handleRematch}
              busy={busy}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Preparation Operations Section ──────────────────────────────────────────

const PREP_STATUS_META: Record<string, { label: string; color: string }> = {
  READY:                  { label: 'جاهز',              color: '#34d399' },
  VALIDATED:              { label: 'مُتحقّق',            color: '#60a5fa' },
  PENDING:                { label: 'انتظار',             color: '#94a3b8' },
  PROCESSING:             { label: 'يعالج',              color: '#f59e0b' },
  LOW_EVIDENCE:           { label: 'أدلة ضعيفة',        color: '#fb923c' },
  PERMANENT_LOW_EVIDENCE: { label: 'أدلة ضعيفة دائمة', color: '#f87171' },
  INVALID:                { label: 'غير صالح',           color: '#ef4444' },
};

const PREP_STATUS_LABELS: Record<string, string> = {
  READY:                  'جاهز',
  VALIDATED:              'مُتحقّق',
  PENDING:                'انتظار',
  PROCESSING:             'يعالج',
  LOW_EVIDENCE:           'أدلة ضعيفة',
  PERMANENT_LOW_EVIDENCE: 'أدلة ضعيفة دائمة',
  INVALID:                'غير صالح',
  preparing:              'قيد التحضير',
  ready:                  'جاهز',
  completed:              'مكتمل',
  paused:                 'موقوف مؤقتاً',
  pending:                'في الانتظار',
  running:                'يعمل الآن',
};

const EVENT_LABELS: Record<string, string> = {
  validation_started:          'بدأ التحقق',
  validation_ready:            'سؤال جاهز ✓',
  validation_derivation_failed:'فشل الاستنتاج',
  validation_low_confidence:   'ثقة منخفضة',
  grading_outcome:             'نتيجة تصحيح',
  quota_exhausted:             'نفدت الحصة اليومية',
  retry_started:               'بدأت إعادة المحاولة',
  retry_completed:             'اكتملت إعادة المحاولة',
  dlq_inserted:                'أُدرج في قائمة الأعطال',
  exam_prepared:               'اكتمل تحضير الامتحان',
  preparation_paused:          'التحضير متوقف مؤقتاً',
  preparation_started:         'بدأ التحضير',
  preparation_completed:       'اكتمل التحضير',
};

const PREP_STATUS_COLORS: Record<PrepOpsDashboard['healthStatus'], { bg: string; border: string; color: string; icon: typeof CheckCircle; label: string }> = {
  healthy:         { bg: 'rgba(52,211,153,0.07)',  border: 'rgba(52,211,153,0.22)',  color: '#34d399', icon: CheckCircle,  label: '🟢 النظام سليم' },
  quota_wait:      { bg: 'rgba(251,191,36,0.07)',  border: 'rgba(251,191,36,0.22)',  color: '#fbbf24', icon: AlertCircle,  label: '🟡 انتظار حصة Gemini' },
  active_recovery: { bg: 'rgba(251,146,60,0.07)',  border: 'rgba(251,146,60,0.22)',  color: '#fb923c', icon: RotateCcw,    label: '🟠 استرداد نشط' },
  stalled:         { bg: 'rgba(248,113,113,0.07)', border: 'rgba(248,113,113,0.22)', color: '#f87171', icon: XCircle,      label: '🔴 التحضير متوقف' },
};

// ─── Scheduler State Panel ────────────────────────────────────────────────────

const SCHED_STATUS_CFG = {
  running:      { color: '#34d399', bg: 'rgba(52,211,153,0.08)',  border: 'rgba(52,211,153,0.22)',  label: 'يُحضّر الآن', dot: true  },
  idle:         { color: '#94a3b8', bg: 'rgba(148,163,184,0.05)', border: 'rgba(148,163,184,0.12)', label: 'خامل',        dot: false },
  quota_paused: { color: '#fbbf24', bg: 'rgba(251,191,36,0.07)',  border: 'rgba(251,191,36,0.20)',  label: 'انتظار حصة', dot: false },
};

function SchedulerStatePanel({ scheduler }: { scheduler: PrepOpsSchedulerState }) {
  const cfg = SCHED_STATUS_CFG[scheduler.status];
  const { activeExam, queueOrder, nextExamPreview } = scheduler;

  return (
    <GlassPanel>
      {/* Header row */}
      <div className="flex items-center justify-between mb-3" dir="rtl">
        <div className="flex items-center gap-2">
          <GitCommitVertical size={15} className="text-[#a78bfa]" />
          <span className="text-xs font-bold text-white">المجدول التسلسلي</span>
          {/* Mode badge */}
          <span className="text-[9px] rounded-full px-2 py-px font-bold"
            style={{ background: 'rgba(167,139,250,0.12)', color: '#a78bfa', border: '1px solid rgba(167,139,250,0.22)' }}
          >
            تسلسلي
          </span>
        </div>
        {/* Status pill */}
        <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-semibold"
          style={{ background: cfg.bg, border: `1px solid ${cfg.border}`, color: cfg.color }}
        >
          {cfg.dot && <div className="h-1.5 w-1.5 rounded-full animate-pulse" style={{ background: cfg.color }} />}
          {cfg.label}
        </span>
      </div>

      {/* Active exam */}
      {activeExam ? (
        <div className="rounded-xl p-3 mb-3"
          style={{ background: 'rgba(52,211,153,0.06)', border: '1px solid rgba(52,211,153,0.18)' }}
        >
          <div className="flex items-start justify-between gap-2 mb-2" dir="rtl">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 mb-0.5">
                <ZapIcon size={11} className="text-emerald-400 flex-shrink-0" />
                <p className="text-[11px] font-bold text-emerald-400">نشط الآن</p>
                <span className="text-[9px] rounded-full px-1.5 py-px"
                  style={{ background: 'rgba(167,139,250,0.12)', color: '#a78bfa', border: '1px solid rgba(167,139,250,0.2)' }}
                >
                  أولوية {activeExam.priority}
                </span>
              </div>
              <p className="text-xs font-semibold text-white truncate">{activeExam.examTitle}</p>
            </div>
            <span className="text-xl font-black flex-shrink-0" style={{ color: activeExam.progressPct >= 80 ? '#34d399' : '#f59e0b' }}>
              {activeExam.progressPct}%
            </span>
          </div>

          {/* Progress bar */}
          <div className="h-2 w-full rounded-full bg-white/[0.06] overflow-hidden mb-2">
            <motion.div className="h-full rounded-full"
              style={{ background: activeExam.progressPct >= 80 ? '#34d399' : activeExam.progressPct >= 40 ? '#f59e0b' : '#f87171' }}
              initial={{ width: 0 }}
              animate={{ width: `${activeExam.progressPct}%` }}
              transition={{ duration: 0.7, ease: 'easeOut' }}
            />
          </div>

          <div className="grid grid-cols-3 gap-2 text-center" dir="rtl">
            <div>
              <p className="text-xs font-black text-white">{activeExam.readyQuestions}</p>
              <p className="text-[9px] text-slate-500">مكتمل</p>
            </div>
            <div>
              <p className="text-xs font-black" style={{ color: activeExam.remainingQuestions > 0 ? '#f59e0b' : '#34d399' }}>
                {activeExam.remainingQuestions}
              </p>
              <p className="text-[9px] text-slate-500">متبقي</p>
            </div>
            <div>
              <p className="text-xs font-black text-white">{activeExam.totalQuestions}</p>
              <p className="text-[9px] text-slate-500">الإجمالي</p>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-center gap-2 rounded-xl py-5 mb-3"
          style={{ background: 'rgba(148,163,184,0.04)', border: '1px solid rgba(148,163,184,0.1)' }}
          dir="rtl"
        >
          <CheckCircle size={15} className="text-slate-500" />
          <p className="text-xs text-slate-500">لا يوجد امتحان نشط حالياً</p>
        </div>
      )}

      {/* Queue order */}
      {queueOrder.length > 1 && (
        <div className="space-y-1.5">
          <p className="text-[10px] font-semibold text-slate-500 mb-1.5" dir="rtl">ترتيب قائمة الانتظار</p>
          {queueOrder.slice(0, 5).map((entry, idx) => {
            const isActive  = entry.status === 'running';
            const pctColor  = entry.progressPct >= 80 ? '#34d399' : entry.progressPct >= 40 ? '#f59e0b' : '#94a3b8';
            return (
              <div key={entry.jobId}
                className="flex items-center gap-2 rounded-lg px-2.5 py-2"
                style={{
                  background: isActive ? 'rgba(52,211,153,0.07)' : 'rgba(255,255,255,0.025)',
                  border: `1px solid ${isActive ? 'rgba(52,211,153,0.2)' : 'rgba(255,255,255,0.06)'}`,
                }}
              >
                {/* Position badge */}
                <span className="text-[10px] font-black w-5 text-center flex-shrink-0"
                  style={{ color: isActive ? '#34d399' : '#64748b' }}>
                  {idx === 0 && isActive ? '▶' : `${entry.position}`}
                </span>

                {/* Title + mini bar */}
                <div className="flex-1 min-w-0" dir="rtl">
                  <p className="text-[11px] font-medium truncate"
                    style={{ color: isActive ? '#fff' : '#94a3b8' }}>
                    {entry.examTitle}
                  </p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <div className="flex-1 h-1 rounded-full bg-white/[0.06] overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${entry.progressPct}%`, background: pctColor }} />
                    </div>
                    <span className="text-[9px] font-bold flex-shrink-0" style={{ color: pctColor }}>
                      {entry.progressPct}%
                    </span>
                  </div>
                </div>

                {/* Remaining */}
                <div className="text-right flex-shrink-0" dir="rtl">
                  <p className="text-[10px] font-bold" style={{ color: entry.remainingQuestions > 0 ? '#f59e0b' : '#34d399' }}>
                    {entry.remainingQuestions}
                  </p>
                  <p className="text-[8px] text-slate-600">متبقي</p>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Next exam preview */}
      {nextExamPreview && (
        <div className="flex items-center gap-2 mt-2.5 rounded-lg px-2.5 py-2"
          style={{ background: 'rgba(96,165,250,0.05)', border: '1px solid rgba(96,165,250,0.15)' }}
          dir="rtl"
        >
          <ArrowRight size={12} className="text-blue-400 flex-shrink-0 rotate-180" />
          <div className="flex-1 min-w-0">
            <p className="text-[10px] text-slate-500">التالي في الانتظار</p>
            <p className="text-[11px] font-semibold text-slate-300 truncate">{nextExamPreview.examTitle}</p>
          </div>
          <span className="text-[10px] font-bold text-blue-400 flex-shrink-0">{nextExamPreview.progressPct}%</span>
        </div>
      )}
    </GlassPanel>
  );
}

function PrepHealthCard({ status }: { status: PrepOpsDashboard['healthStatus'] }) {
  const cfg = PREP_STATUS_COLORS[status];
  const Icon = cfg.icon;
  return (
    <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }}
      className="flex items-center gap-3 rounded-2xl p-4 mb-3"
      style={{ background: cfg.bg, border: `1px solid ${cfg.border}` }}
    >
      <Icon size={22} style={{ color: cfg.color }} className="flex-shrink-0" />
      <div dir="rtl">
        <p className="text-base font-bold" style={{ color: cfg.color }}>{cfg.label}</p>
        <p className="text-[10px] text-slate-500 mt-0.5">حالة نظام التحضير في الوقت الفعلي</p>
      </div>
    </motion.div>
  );
}

function PrepOpsSection({ data, lastRefresh }: { data: PrepOpsDashboard; lastRefresh: Date }) {
  const { globalSummary, preparationStatus, queueStatus, geminiStatus, runningJobs, examTable, orphanCount, recentEvents } = data;

  return (
    <div className="space-y-3">

      {/* ── Health Card ───────────────────────────────────────────────── */}
      <PrepHealthCard status={data.healthStatus} />

      {/* ── Sequential Scheduler State ───────────────────────────────── */}
      {data.scheduler && <SchedulerStatePanel scheduler={data.scheduler} />}

      {/* ── Auto-refresh indicator ────────────────────────────────────── */}
      <div className="flex items-center justify-end gap-1.5 -mt-1 mb-1">
        <div className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
        <span className="text-[9px] text-slate-600">تحديث تلقائي كل 10 ثوان • آخر تحديث: {lastRefresh.toLocaleTimeString('ar-EG')}</span>
      </div>

      {/* ── Global Summary ────────────────────────────────────────────── */}
      <GlassPanel>
        <SectionTitle icon={Layers} title="الملخص العام" color="#00c6ff" />
        <div className="grid grid-cols-3 gap-2" dir="rtl">
          {[
            { label: 'كتب المناهج', value: globalSummary.totalBooks,     color: '#00c6ff' },
            { label: 'الامتحانات',   value: globalSummary.totalExams,     color: '#a78bfa' },
            { label: 'الأسئلة',      value: globalSummary.totalQuestions, color: '#f59e0b' },
          ].map(({ label, value, color }) => (
            <div key={label} className="flex flex-col items-center rounded-xl py-3"
              style={{ background: `${color}09`, border: `1px solid ${color}22` }}
            >
              <span className="text-xl font-black" style={{ color }}>{value.toLocaleString('ar')}</span>
              <span className="text-[9px] text-slate-500 mt-1">{label}</span>
            </div>
          ))}
        </div>
      </GlassPanel>

      {/* ── Preparation Status ────────────────────────────────────────── */}
      <GlassPanel>
        <SectionTitle icon={ListChecks} title="حالة التحضير" color="#34d399" />
        <div className="space-y-2" dir="rtl">
          {Object.entries(PREP_STATUS_META).map(([key, meta]) => {
            const count = preparationStatus.counts[key] ?? 0;
            const pct   = preparationStatus.percentages[key] ?? 0;
            return (
              <div key={key}>
                <div className="flex items-center justify-between mb-0.5">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] font-semibold" style={{ color: meta.color }}>{meta.label}</span>
                    <span className="text-[10px] text-slate-500">({pct}%)</span>
                  </div>
                  <span className="text-xs font-bold text-white">{count.toLocaleString('ar')}</span>
                </div>
                <MetricBar value={pct} max={100} color={meta.color} />
              </div>
            );
          })}
          <div className="pt-1 mt-1 border-t border-white/[0.05] flex items-center justify-between" dir="rtl">
            <span className="text-[10px] text-slate-500">الإجمالي المُحضَّر</span>
            <span className="text-xs font-bold text-white">{preparationStatus.total.toLocaleString('ar')}</span>
          </div>
        </div>
      </GlassPanel>

      {/* ── Queue Status ──────────────────────────────────────────────── */}
      <GlassPanel>
        <SectionTitle icon={Inbox} title="حالة قائمة الانتظار" color="#a78bfa" />
        <div className="grid grid-cols-4 gap-1.5" dir="rtl">
          {[
            { label: 'يعمل',    value: queueStatus.active,  color: '#34d399' },
            { label: 'انتظار',  value: queueStatus.waiting, color: '#94a3b8' },
            { label: 'موقوف',   value: queueStatus.paused,  color: '#f59e0b' },
            { label: 'إعادة',   value: queueStatus.retry,   color: '#fb923c' },
            { label: 'مكتمل',   value: queueStatus.done,    color: '#60a5fa' },
            { label: 'فشل',     value: queueStatus.failed,  color: '#f87171' },
            { label: 'DLQ',     value: queueStatus.dlq,     color: queueStatus.dlq > 0 ? '#ef4444' : '#64748b' },
          ].map(({ label, value, color }) => (
            <div key={label} className="flex flex-col items-center rounded-xl py-2.5 col-span-1"
              style={{ background: `${color}09`, border: `1px solid ${value > 0 && label === 'DLQ' ? '#ef444440' : `${color}20`}` }}
            >
              <span className="text-sm font-black" style={{ color }}>{value}</span>
              <span className="text-[9px] text-slate-500 mt-0.5">{label}</span>
            </div>
          ))}
        </div>
      </GlassPanel>

      {/* ── Gemini Status ─────────────────────────────────────────────── */}
      <GlassPanel>
        <SectionTitle icon={Brain} title="حالة Gemini" color="#a78bfa" />
        <div className="space-y-1" dir="rtl">
          <KpiRow label="المزوّد"           value={<span className="text-xs font-bold text-white">{geminiStatus.provider}</span>} />
          <KpiRow label="طلبات اليوم"       value={
            <span className="text-lg font-black" style={{ color: '#a78bfa' }}>
              {geminiStatus.callsToday.toLocaleString('ar')}
            </span>
          } />
          <KpiRow label="أخطاء الحصة"       value={
            <span style={{ color: geminiStatus.quotaErrors > 0 ? '#f87171' : '#34d399' }}>
              {geminiStatus.quotaErrors}
            </span>
          } />
          <KpiRow label="آخر خطأ حصة"       value={geminiStatus.lastQuotaError ? formatTS(geminiStatus.lastQuotaError) : <span className="text-slate-500">—</span>} />
          <KpiRow label="النشاط الحالي"     value={
            <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold"
              style={{
                background: geminiStatus.isActive ? 'rgba(52,211,153,0.12)' : 'rgba(148,163,184,0.08)',
                border: `1px solid ${geminiStatus.isActive ? 'rgba(52,211,153,0.3)' : 'rgba(148,163,184,0.15)'}`,
                color: geminiStatus.isActive ? '#34d399' : '#94a3b8',
              }}
            >
              {geminiStatus.isActive ? <><div className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />يُحضّر</> : 'خامل'}
            </span>
          } />
        </div>
      </GlassPanel>

      {/* ── Running Jobs ──────────────────────────────────────────────── */}
      <GlassPanel>
        <SectionTitle icon={CpuIcon} title={`المهام الجارية (${runningJobs.length})`} color="#f59e0b" />
        {runningJobs.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-6" dir="rtl">
            <CheckCircle size={20} className="text-emerald-400" />
            <p className="text-xs text-slate-500">لا توجد مهام نشطة</p>
          </div>
        ) : (
          <div className="space-y-2.5">
            {runningJobs.map(job => (
              <div key={job.jobId} className="rounded-xl p-2.5"
                style={{ background: 'rgba(245,158,11,0.05)', border: '1px solid rgba(245,158,11,0.15)' }}
              >
                <div className="flex items-start justify-between gap-2 mb-2" dir="rtl">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold text-white truncate">{job.examTitle}</p>
                    <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                      <span className="text-[9px] rounded-full px-1.5 py-px font-medium"
                        style={{ background: 'rgba(245,158,11,0.12)', color: '#f59e0b' }}
                      >{job.status}</span>
                      {job.workerId && <span className="text-[9px] text-slate-600 font-mono truncate max-w-[80px]">{job.workerId.slice(0, 12)}…</span>}
                    </div>
                  </div>
                  <span className="text-sm font-black flex-shrink-0" style={{ color: job.progressPct >= 80 ? '#34d399' : '#f59e0b' }}>
                    {job.progressPct}%
                  </span>
                </div>
                {/* Progress bar */}
                <div className="h-1.5 w-full rounded-full bg-white/[0.06] overflow-hidden mb-1.5">
                  <motion.div className="h-full rounded-full"
                    style={{ background: job.progressPct >= 80 ? '#34d399' : '#f59e0b' }}
                    initial={{ width: 0 }} animate={{ width: `${job.progressPct}%` }}
                    transition={{ duration: 0.6, ease: 'easeOut' }}
                  />
                </div>
                <div className="flex items-center justify-between text-[9px] text-slate-600" dir="rtl">
                  <span>{job.readyQuestions} / {job.totalQuestions} سؤال</span>
                  {job.heartbeat && <span>نبضة: {timeAgo(job.heartbeat)}</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </GlassPanel>

      {/* ── Orphan Monitor ────────────────────────────────────────────── */}
      <div className="rounded-2xl p-3"
        style={{
          background:  orphanCount > 0 ? 'rgba(239,68,68,0.07)'  : 'rgba(52,211,153,0.05)',
          border: `1px solid ${orphanCount > 0 ? 'rgba(239,68,68,0.25)' : 'rgba(52,211,153,0.15)'}`,
        }}
      >
        <div className="flex items-center justify-between" dir="rtl">
          <div className="flex items-center gap-2">
            {orphanCount > 0
              ? <AlertCircle size={16} className="text-red-400 flex-shrink-0" />
              : <CheckCircle size={16} className="text-emerald-400 flex-shrink-0" />}
            <div>
              <p className="text-xs font-semibold" style={{ color: orphanCount > 0 ? '#ef4444' : '#34d399' }}>
                {orphanCount > 0 ? `تحذير: ${orphanCount} سؤال يتيم` : 'لا توجد أسئلة يتيمة'}
              </p>
              <p className="text-[10px] text-slate-500">أسئلة MCQ بدون إجابة قانونية</p>
            </div>
          </div>
          <span className="text-2xl font-black" style={{ color: orphanCount > 0 ? '#ef4444' : '#34d399' }}>
            {orphanCount}
          </span>
        </div>
      </div>

      {/* ── Exam Preparation Table ────────────────────────────────────── */}
      <GlassPanel>
        <SectionTitle icon={TrendingUp} title="جدول تحضير الامتحانات (مرتب تصاعدياً)" color="#60a5fa" />
        <div className="overflow-x-auto -mx-1">
          <table className="w-full text-[10px]" dir="rtl">
            <thead>
              <tr className="text-slate-500 border-b border-white/[0.06]">
                <th className="text-right pb-2 pr-1 font-medium min-w-[100px]">الامتحان</th>
                <th className="text-center pb-2 px-1 font-medium">المجموع</th>
                <th className="text-center pb-2 px-1 font-medium" style={{ color: '#34d399' }}>READY</th>
                <th className="text-center pb-2 px-1 font-medium" style={{ color: '#60a5fa' }}>VALID</th>
                <th className="text-center pb-2 px-1 font-medium" style={{ color: '#fb923c' }}>LOW</th>
                <th className="text-center pb-2 px-1 font-medium" style={{ color: '#f87171' }}>PERM</th>
                <th className="text-center pb-2 px-1 font-medium">%</th>
                <th className="text-center pb-2 px-1 font-medium min-w-[60px]">الحالة</th>
              </tr>
            </thead>
            <tbody>
              {examTable.map(row => {
                const pctColor = row.completionPct >= 80 ? '#34d399' : row.completionPct >= 40 ? '#f59e0b' : '#f87171';
                return (
                  <tr key={row.examId} className="border-b border-white/[0.04] hover:bg-white/[0.02] transition-colors">
                    <td className="py-2 pr-1 text-right">
                      <p className="text-white font-medium leading-tight truncate max-w-[110px]">{row.title}</p>
                      <p className="text-slate-600 text-[9px]">{row.totalQuestions} سؤال</p>
                    </td>
                    <td className="text-center py-2 px-1 text-slate-400">{row.totalQuestions}</td>
                    <td className="text-center py-2 px-1 font-bold" style={{ color: '#34d399' }}>{row.ready}</td>
                    <td className="text-center py-2 px-1 font-bold" style={{ color: '#60a5fa' }}>{row.validated}</td>
                    <td className="text-center py-2 px-1 font-bold" style={{ color: '#fb923c' }}>{row.lowEvidence}</td>
                    <td className="text-center py-2 px-1 font-bold" style={{ color: '#f87171' }}>{row.permanentLow}</td>
                    <td className="text-center py-2 px-1">
                      <span className="font-black text-sm" style={{ color: pctColor }}>{row.completionPct}%</span>
                      <span className="block text-[8px] text-slate-600">{row.ready}/{row.totalQuestions} جاهز</span>
                    </td>
                    <td className="text-center py-2 px-1">
                      {(() => {
                        const status = row.queueStatus ?? row.preparationStatus;
                        const label = PREP_STATUS_LABELS[status] ?? status;
                        const isPaused = row.queueStatus === 'paused';
                        const isRunning = row.queueStatus === 'running';
                        const isReady = !row.queueStatus && ['READY', 'ready', 'completed'].includes(row.preparationStatus);
                        const color = isPaused ? '#f59e0b' : isRunning ? '#34d399' : isReady ? '#34d399' : '#94a3b8';
                        return (
                      <span className="rounded-full px-1.5 py-px text-[9px] font-medium"
                        style={{
                          background: `${color}1f`,
                          color,
                        }}
                      >
                        {label || '—'}
                      </span>
                        );
                      })()}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </GlassPanel>

      {/* ── Recent Preparation Events ─────────────────────────────────── */}
      <GlassPanel>
        <SectionTitle icon={Activity} title="أحدث أحداث التحضير" color="#94a3b8" />
        {recentEvents.length === 0 ? (
          <p className="text-center text-xs text-slate-500 py-4" dir="rtl">لا توجد أحداث بعد</p>
        ) : (
          <div className="space-y-1.5 max-h-80 overflow-y-auto pr-0.5">
            {recentEvents.map(ev => {
              const isError = ev.severity === 'error' || ev.event.includes('fail') || ev.event.includes('error');
              const isSuccess = ev.event.includes('ready') || ev.event.includes('completed');
              const evColor = isError ? '#f87171' : isSuccess ? '#34d399' : '#94a3b8';
              return (
                <div key={ev.id} className="flex items-start gap-2 rounded-xl p-2"
                  style={{ background: `${evColor}06`, border: `1px solid ${evColor}15` }}
                >
                  <div className="h-1.5 w-1.5 rounded-full mt-1.5 flex-shrink-0" style={{ background: evColor }} />
                  <div className="flex-1 min-w-0" dir="rtl">
                    <div className="flex items-center justify-between gap-1">
                      <p className="text-[11px] font-medium truncate" style={{ color: evColor }}>
                        {EVENT_LABELS[ev.event] ?? ev.event}
                      </p>
                      <span className="text-[9px] text-slate-600 flex-shrink-0">{timeAgo(ev.createdAt)}</span>
                    </div>
                    {ev.examId && <p className="text-[9px] text-slate-600 font-mono truncate mt-0.5">{ev.examId.slice(0, 16)}…</p>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </GlassPanel>

    </div>
  );
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────

type Tab = 'health' | 'metrics' | 'backup' | 'audit' | 'links' | 'prep';

const TABS: { id: Tab; label: string; icon: typeof Shield }[] = [
  { id: 'health',  label: 'الصحة',    icon: Activity  },
  { id: 'metrics', label: 'المقاييس', icon: BarChart2  },
  { id: 'backup',  label: 'النسخ',    icon: HardDrive  },
  { id: 'audit',   label: 'التدقيق',  icon: Eye        },
  { id: 'links',   label: 'الربط',    icon: Link2      },
  { id: 'prep',    label: 'التحضير',  icon: ListChecks },
];

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function AdminDashboard() {
  const { setPage } = useAppStore();
  const [activeTab, setActiveTab] = useState<Tab>('health');

  const [health,       setHealth]       = useState<SystemHealth | null>(null);
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [metrics,      setMetrics]      = useState<MetricsSnapshot | null>(null);
  const [usage,        setUsage]        = useState<UsageSummary | null>(null);
  const [cache,        setCache]        = useState<CacheMetrics | null>(null);
  const [prepOps,      setPrepOps]      = useState<PrepOpsDashboard | null>(null);
  const [prepLastRefresh, setPrepLastRefresh] = useState<Date>(new Date());

  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [triggering, setTriggering] = useState(false);
  const [backupMsg,  setBackupMsg]  = useState<string | null>(null);

  const prepIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadPrepOps = useCallback(async () => {
    try {
      const data = await fetchPrepOps();
      setPrepOps(data);
      setPrepLastRefresh(new Date());
    } catch {
      // prep ops errors are non-fatal — don't replace whole page error
    }
  }, []);

  // Auto-refresh prep tab every 10 s while it is active
  useEffect(() => {
    if (activeTab === 'prep') {
      loadPrepOps();
      prepIntervalRef.current = setInterval(loadPrepOps, 10_000);
    } else {
      if (prepIntervalRef.current) {
        clearInterval(prepIntervalRef.current);
        prepIntervalRef.current = null;
      }
    }
    return () => {
      if (prepIntervalRef.current) {
        clearInterval(prepIntervalRef.current);
        prepIntervalRef.current = null;
      }
    };
  }, [activeTab, loadPrepOps]);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    else setRefreshing(true);
    setError(null);
    try {
      const [h, a, m, u, c] = await Promise.all([
        fetchSystemHealth(),
        fetchAuditLog({ limit: 50 }),
        fetchMetrics(),
        fetchUsageSummary(),
        fetchCacheMetrics(),
      ]);
      setHealth(h);
      setAuditEntries(a.entries);
      setMetrics(m);
      setUsage(u);
      setCache(c);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleTriggerBackup = async () => {
    setTriggering(true);
    setBackupMsg(null);
    try {
      await triggerBackup();
      setBackupMsg('بدأ النسخ الاحتياطي في الخلفية');
      setTimeout(() => load(true), 4000);
    } catch (e) {
      setBackupMsg(`فشل: ${String(e)}`);
    } finally {
      setTriggering(false);
    }
  };

  return (
    <PageWrapper>
      <div className="px-4 pt-12 pb-6">

        {/* Header */}
        <div className="mb-5 flex items-center gap-3">
          <motion.button whileTap={{ scale: 0.9 }} onClick={() => setPage('profile')}
            className="flex h-9 w-9 items-center justify-center rounded-xl flex-shrink-0"
            style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)' }}
          >
            <ChevronLeft size={18} className="text-slate-400" />
          </motion.button>
          <div className="flex-1" dir="rtl">
            <p className="text-[10px] font-medium uppercase tracking-widest text-slate-500">للمسؤولين فقط</p>
            <h1 className="text-xl font-bold text-white">لوحة الإدارة</h1>
          </div>
          <motion.button whileTap={{ scale: 0.9 }} onClick={() => load(true)} disabled={refreshing || loading}
            className="flex h-9 w-9 items-center justify-center rounded-xl flex-shrink-0"
            style={{ background: 'rgba(0,198,255,0.08)', border: '1px solid rgba(0,198,255,0.15)' }}
          >
            <motion.div animate={{ rotate: refreshing ? 360 : 0 }}
              transition={{ duration: 0.8, repeat: refreshing ? Infinity : 0, ease: 'linear' }}
            >
              <RefreshCw size={15} className="text-[#00c6ff]" />
            </motion.div>
          </motion.button>
        </div>

        <AnimatePresence mode="wait">
          {loading && (
            <motion.div key="loading" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="flex flex-col items-center gap-3 py-16"
            >
              <div className="flex gap-1.5">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-1.5 w-1.5 rounded-full bg-[#00c6ff] animate-pulse"
                    style={{ animationDelay: `${i * 0.2}s` }} />
                ))}
              </div>
              <p className="text-xs text-slate-500" dir="rtl">جارٍ تحميل بيانات النظام…</p>
            </motion.div>
          )}

          {!loading && error && (
            <motion.div key="error" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="flex flex-col items-center gap-3 py-16"
            >
              <XCircle size={32} className="text-red-400" />
              <p className="text-sm font-semibold text-red-400" dir="rtl">تعذّر تحميل البيانات</p>
              <p className="text-[11px] text-slate-500 text-center" dir="rtl">{error}</p>
              <motion.button whileTap={{ scale: 0.95 }} onClick={() => load()}
                className="rounded-xl px-4 py-2 text-xs font-semibold text-[#00c6ff]"
                style={{ background: 'rgba(0,198,255,0.1)', border: '1px solid rgba(0,198,255,0.2)' }}
              >
                إعادة المحاولة
              </motion.button>
            </motion.div>
          )}

          {!loading && !error && health && (
            <motion.div key="content" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>

              <QuickStats health={health} metrics={metrics} />

              <AnimatePresence>
                {backupMsg && (
                  <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
                    className="mb-3 rounded-xl px-3 py-2 text-xs text-center"
                    style={{ background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.2)', color: '#f59e0b' }}
                    dir="rtl"
                  >
                    {backupMsg}
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Tabs */}
              <div className="mb-4 flex rounded-2xl p-1 gap-1"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}
              >
                {TABS.map((tab) => {
                  const Icon = tab.icon;
                  const isActive = activeTab === tab.id;
                  return (
                    <motion.button key={tab.id} whileTap={{ scale: 0.95 }} onClick={() => setActiveTab(tab.id)}
                      className="relative flex flex-1 items-center justify-center gap-1 rounded-xl py-2 text-[10px] font-semibold transition-colors"
                      style={{ color: isActive ? '#00c6ff' : 'rgba(148,163,184,0.6)' }}
                    >
                      {isActive && (
                        <motion.div layoutId="admin-tab-bg" className="absolute inset-0 rounded-xl"
                          style={{ background: 'rgba(0,198,255,0.1)', border: '1px solid rgba(0,198,255,0.2)' }}
                          transition={{ type: 'spring', stiffness: 350, damping: 30 }}
                        />
                      )}
                      <Icon size={12} className="relative z-10" />
                      <span className="relative z-10" dir="rtl">{tab.label}</span>
                    </motion.button>
                  );
                })}
              </div>

              {/* Tab content */}
              <AnimatePresence mode="wait">
                {activeTab === 'health' && (
                  <motion.div key="health" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}>
                    <HealthSection health={health} />
                  </motion.div>
                )}
                {activeTab === 'metrics' && (
                  <motion.div key="metrics" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}>
                    <MetricsSection metrics={metrics} usage={usage} cache={cache} />
                  </motion.div>
                )}
                {activeTab === 'backup' && (
                  <motion.div key="backup" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}>
                    <BackupSection backup={health.backup} onTrigger={handleTriggerBackup} triggering={triggering} />
                  </motion.div>
                )}
                {activeTab === 'audit' && (
                  <motion.div key="audit" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}>
                    <AuditLogSection entries={auditEntries} />
                  </motion.div>
                )}
                {activeTab === 'links' && (
                  <motion.div key="links" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}>
                    <CurriculumLinksSection />
                  </motion.div>
                )}
                {activeTab === 'prep' && (
                  <motion.div key="prep" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}>
                    {prepOps ? (
                      <PrepOpsSection data={prepOps} lastRefresh={prepLastRefresh} />
                    ) : (
                      <div className="flex flex-col items-center gap-3 py-16">
                        <div className="flex gap-1.5">
                          {[0,1,2].map(i => (
                            <div key={i} className="h-1.5 w-1.5 rounded-full bg-[#34d399] animate-pulse"
                              style={{ animationDelay: `${i * 0.2}s` }} />
                          ))}
                        </div>
                        <p className="text-xs text-slate-500" dir="rtl">جارٍ تحميل بيانات التحضير…</p>
                      </div>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>

            </motion.div>
          )}
        </AnimatePresence>

      </div>
    </PageWrapper>
  );
}
