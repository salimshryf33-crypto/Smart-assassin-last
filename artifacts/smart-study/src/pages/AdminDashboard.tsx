import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Shield, Activity, Database, HardDrive, Clock, Brain,
  RefreshCw, ChevronLeft, CheckCircle, XCircle, AlertCircle,
  Server, Cpu, MemoryStick, FileArchive, Eye, EyeOff,
  Search, FileText, BarChart2, Zap,
} from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import PageWrapper from '../components/layout/PageWrapper';
import {
  fetchSystemHealth, fetchAuditLog, triggerBackup,
  fetchMetrics, fetchUsageSummary, fetchCacheMetrics,
  type SystemHealth, type AuditEntry,
  type MetricsSnapshot, type UsageSummary, type CacheMetrics,
} from '../utils/adminApi';

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

// ─── Tabs ─────────────────────────────────────────────────────────────────────

type Tab = 'health' | 'metrics' | 'backup' | 'audit';

const TABS: { id: Tab; label: string; icon: typeof Shield }[] = [
  { id: 'health',  label: 'الصحة',    icon: Activity  },
  { id: 'metrics', label: 'المقاييس', icon: BarChart2  },
  { id: 'backup',  label: 'النسخ',    icon: HardDrive  },
  { id: 'audit',   label: 'التدقيق',  icon: Eye        },
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

  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [triggering, setTriggering] = useState(false);
  const [backupMsg,  setBackupMsg]  = useState<string | null>(null);

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
              </AnimatePresence>

            </motion.div>
          )}
        </AnimatePresence>

      </div>
    </PageWrapper>
  );
}
