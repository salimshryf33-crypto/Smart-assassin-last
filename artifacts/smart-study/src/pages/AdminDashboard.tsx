import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Shield, Activity, Database, HardDrive, Clock, Users,
  RefreshCw, ChevronLeft, CheckCircle, XCircle, AlertCircle,
  Server, Cpu, MemoryStick, FileArchive, Eye, EyeOff,
} from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import PageWrapper from '../components/layout/PageWrapper';
import {
  fetchSystemHealth, fetchAuditLog, triggerBackup,
  type SystemHealth, type AuditEntry,
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
  const d = new Date(iso);
  return d.toLocaleString('ar-EG', { dateStyle: 'short', timeStyle: 'short' });
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

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatusBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold"
      style={{
        background: ok ? 'rgba(52,211,153,0.12)' : 'rgba(248,113,113,0.12)',
        border:     `1px solid ${ok ? 'rgba(52,211,153,0.3)' : 'rgba(248,113,113,0.3)'}`,
        color:      ok ? '#34d399' : '#f87171',
      }}
    >
      {ok ? <CheckCircle size={9} /> : <XCircle size={9} />}
      {label}
    </span>
  );
}

function GlassPanel({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-2xl p-4 ${className}`}
      style={{
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(255,255,255,0.08)',
      }}
    >
      {children}
    </div>
  );
}

function SectionTitle({ icon: Icon, title, color = '#00c6ff' }: { icon: typeof Shield; title: string; color?: string }) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <div
        className="flex h-7 w-7 items-center justify-center rounded-xl"
        style={{ background: `${color}18`, border: `1px solid ${color}30` }}
      >
        <Icon size={14} style={{ color }} strokeWidth={2} />
      </div>
      <span className="text-sm font-semibold text-white" dir="rtl">{title}</span>
    </div>
  );
}

// ─── Health Section ───────────────────────────────────────────────────────────

function HealthSection({ health }: { health: SystemHealth }) {
  const { server, database, backup, security } = health;
  const isHealthy = health.status === 'healthy';

  return (
    <div className="space-y-3">
      {/* Status banner */}
      <motion.div
        initial={{ opacity: 0, y: -6 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex items-center gap-3 rounded-2xl p-3"
        style={{
          background: isHealthy ? 'rgba(52,211,153,0.07)' : 'rgba(251,191,36,0.07)',
          border: `1px solid ${isHealthy ? 'rgba(52,211,153,0.2)' : 'rgba(251,191,36,0.2)'}`,
        }}
      >
        {isHealthy
          ? <CheckCircle size={18} className="text-emerald-400 flex-shrink-0" />
          : <AlertCircle size={18} className="text-amber-400 flex-shrink-0" />
        }
        <div dir="rtl">
          <p className="text-sm font-semibold" style={{ color: isHealthy ? '#34d399' : '#fbbf24' }}>
            {isHealthy ? 'النظام يعمل بشكل طبيعي' : 'النظام يعمل مع تحذيرات'}
          </p>
          <p className="text-[10px] text-slate-500">{formatTS(health.timestamp)}</p>
        </div>
      </motion.div>

      {/* Server stats */}
      <GlassPanel>
        <SectionTitle icon={Server} title="معلومات السيرفر" />
        <div className="grid grid-cols-2 gap-2" dir="rtl">
          <div className="flex items-center gap-2 rounded-xl bg-white/[0.03] p-2.5">
            <Clock size={13} className="text-[#00c6ff]" />
            <div>
              <p className="text-[10px] text-slate-500">وقت التشغيل</p>
              <p className="text-xs font-bold text-white">{formatUptime(server.uptimeSeconds)}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-xl bg-white/[0.03] p-2.5">
            <Cpu size={13} className="text-violet-400" />
            <div>
              <p className="text-[10px] text-slate-500">معالجات</p>
              <p className="text-xs font-bold text-white">{server.cpus} cores</p>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-xl bg-white/[0.03] p-2.5">
            <MemoryStick size={13} className="text-amber-400" />
            <div>
              <p className="text-[10px] text-slate-500">RAM المستخدمة</p>
              <p className="text-xs font-bold text-white">{server.memory.heapUsedMB} MB</p>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-xl bg-white/[0.03] p-2.5">
            <Activity size={13} className="text-emerald-400" />
            <div>
              <p className="text-[10px] text-slate-500">Node.js</p>
              <p className="text-xs font-bold text-white">{server.nodeVersion}</p>
            </div>
          </div>
        </div>
      </GlassPanel>

      {/* Database */}
      <GlassPanel>
        <SectionTitle icon={Database} title="قاعدة البيانات" color="#a78bfa" />
        <div className="space-y-2" dir="rtl">
          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-400">الاتصال</span>
            <StatusBadge ok={database.connected} label={database.connected ? 'متصل' : 'غير متصل'} />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-400">سجلات التدقيق</span>
            <span className="text-xs font-semibold text-white">{database.auditEntries.toLocaleString('ar')}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-400">الأدوار المعيّنة</span>
            <span className="text-xs font-semibold text-white">{database.assignedRoles}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-400">وقت السيرفر</span>
            <span className="text-xs font-semibold text-slate-300">{formatTS(database.serverTime)}</span>
          </div>
        </div>
      </GlassPanel>

      {/* Security features */}
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
                {enabled
                  ? <CheckCircle size={11} className="text-emerald-400 flex-shrink-0" />
                  : <XCircle size={11} className="text-red-400 flex-shrink-0" />
                }
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

function BackupSection({
  backup,
  onTrigger,
  triggering,
}: {
  backup: SystemHealth['backup'];
  onTrigger: () => void;
  triggering: boolean;
}) {
  return (
    <GlassPanel>
      <div className="flex items-center justify-between mb-3">
        <SectionTitle icon={HardDrive} title="النسخ الاحتياطي" color="#f59e0b" />
        <motion.button
          whileTap={{ scale: 0.92 }}
          onClick={onTrigger}
          disabled={triggering}
          className="flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-[11px] font-semibold"
          style={{
            background: 'rgba(245,158,11,0.1)',
            border: '1px solid rgba(245,158,11,0.25)',
            color: '#f59e0b',
            opacity: triggering ? 0.5 : 1,
          }}
        >
          <FileArchive size={11} />
          {triggering ? 'جارٍ...' : 'نسخ الآن'}
        </motion.button>
      </div>
      <div className="space-y-2" dir="rtl">
        <div className="flex items-center justify-between">
          <span className="text-xs text-slate-400">آخر نسخة</span>
          <span className="text-xs font-semibold text-white">{formatTS(backup.lastRun)}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-slate-400">الحالة</span>
          {backup.lastStatus
            ? <StatusBadge ok={backup.lastStatus === 'success'} label={backup.lastStatus === 'success' ? 'ناجحة' : backup.lastStatus} />
            : <span className="text-xs text-slate-500">لا توجد نسخة بعد</span>
          }
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-slate-400">الحجم</span>
          <span className="text-xs font-semibold text-white">
            {backup.lastSizeKB ? `${(backup.lastSizeKB / 1024).toFixed(1)} MB` : '—'}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-slate-400">إجمالي النسخ</span>
          <span className="text-xs font-semibold text-white">{backup.totalRuns}</span>
        </div>
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
        <button
          onClick={() => setShowIds((v) => !v)}
          className="text-[10px] text-slate-500 flex items-center gap-1"
        >
          {showIds ? <EyeOff size={11} /> : <Eye size={11} />}
          {showIds ? 'إخفاء IDs' : 'إظهار IDs'}
        </button>
      </div>
      <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
        <AnimatePresence initial={false}>
          {entries.map((entry) => (
            <motion.div
              key={entry.id}
              initial={{ opacity: 0, x: 8 }}
              animate={{ opacity: 1, x: 0 }}
              className="rounded-xl p-2.5"
              style={{ background: 'rgba(96,165,250,0.05)', border: '1px solid rgba(96,165,250,0.1)' }}
            >
              <div className="flex items-start justify-between gap-2" dir="rtl">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-white truncate">
                    {ACTION_LABELS[entry.action] ?? entry.action}
                  </p>
                  {entry.resource_type && (
                    <p className="text-[10px] text-slate-400 mt-0.5">
                      {entry.resource_type}{entry.resource_id ? `: ${entry.resource_id.slice(0, 12)}…` : ''}
                    </p>
                  )}
                  {showIds && entry.uid && (
                    <p className="text-[9px] text-slate-600 mt-0.5 font-mono">{entry.uid.slice(0, 20)}…</p>
                  )}
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

// ─── Quick Stats Bar ──────────────────────────────────────────────────────────

function QuickStats({ health }: { health: SystemHealth }) {
  const stats = [
    { label: 'وقت التشغيل', value: formatUptime(health.server.uptimeSeconds), color: '#00c6ff' },
    { label: 'سجلات التدقيق', value: health.database.auditEntries, color: '#a78bfa' },
    { label: 'RAM MB', value: health.server.memory.heapUsedMB, color: '#f59e0b' },
    { label: 'الأدوار', value: health.database.assignedRoles, color: '#34d399' },
  ];

  return (
    <div className="grid grid-cols-4 gap-2 mb-4">
      {stats.map((s) => (
        <motion.div
          key={s.label}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
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

type Tab = 'health' | 'backup' | 'audit';

const TABS: { id: Tab; label: string; icon: typeof Shield }[] = [
  { id: 'health', label: 'الصحة', icon: Activity },
  { id: 'backup', label: 'النسخ', icon: HardDrive },
  { id: 'audit',  label: 'التدقيق', icon: Eye },
];

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function AdminDashboard() {
  const { setPage } = useAppStore();
  const [activeTab, setActiveTab] = useState<Tab>('health');
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [triggering, setTriggering] = useState(false);
  const [backupMsg, setBackupMsg] = useState<string | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    else setRefreshing(true);
    setError(null);
    try {
      const [h, a] = await Promise.all([
        fetchSystemHealth(),
        fetchAuditLog({ limit: 50 }),
      ]);
      setHealth(h);
      setAuditEntries(a.entries);
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
          <motion.button
            whileTap={{ scale: 0.9 }}
            onClick={() => setPage('profile')}
            className="flex h-9 w-9 items-center justify-center rounded-xl flex-shrink-0"
            style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)' }}
          >
            <ChevronLeft size={18} className="text-slate-400" />
          </motion.button>
          <div className="flex-1" dir="rtl">
            <p className="text-[10px] font-medium uppercase tracking-widest text-slate-500">للمسؤولين فقط</p>
            <h1 className="text-xl font-bold text-white">لوحة الإدارة</h1>
          </div>
          <motion.button
            whileTap={{ scale: 0.9 }}
            onClick={() => load(true)}
            disabled={refreshing || loading}
            className="flex h-9 w-9 items-center justify-center rounded-xl flex-shrink-0"
            style={{ background: 'rgba(0,198,255,0.08)', border: '1px solid rgba(0,198,255,0.15)' }}
          >
            <motion.div animate={{ rotate: refreshing ? 360 : 0 }} transition={{ duration: 0.8, repeat: refreshing ? Infinity : 0, ease: 'linear' }}>
              <RefreshCw size={15} className="text-[#00c6ff]" />
            </motion.div>
          </motion.button>
        </div>

        {/* Loading */}
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

          {/* Error */}
          {!loading && error && (
            <motion.div key="error" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="flex flex-col items-center gap-3 py-16"
            >
              <XCircle size={32} className="text-red-400" />
              <p className="text-sm font-semibold text-red-400" dir="rtl">تعذّر تحميل البيانات</p>
              <p className="text-[11px] text-slate-500 text-center" dir="rtl">{error}</p>
              <motion.button
                whileTap={{ scale: 0.95 }}
                onClick={() => load()}
                className="rounded-xl px-4 py-2 text-xs font-semibold text-[#00c6ff]"
                style={{ background: 'rgba(0,198,255,0.1)', border: '1px solid rgba(0,198,255,0.2)' }}
              >
                إعادة المحاولة
              </motion.button>
            </motion.div>
          )}

          {/* Content */}
          {!loading && !error && health && (
            <motion.div key="content" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>

              {/* Quick stats */}
              <QuickStats health={health} />

              {/* Backup message */}
              <AnimatePresence>
                {backupMsg && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
                    className="mb-3 rounded-xl px-3 py-2 text-xs text-center"
                    style={{ background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.2)', color: '#f59e0b' }}
                    dir="rtl"
                  >
                    {backupMsg}
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Tabs */}
              <div
                className="mb-4 flex rounded-2xl p-1 gap-1"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}
              >
                {TABS.map((tab) => {
                  const Icon = tab.icon;
                  const isActive = activeTab === tab.id;
                  return (
                    <motion.button
                      key={tab.id}
                      whileTap={{ scale: 0.95 }}
                      onClick={() => setActiveTab(tab.id)}
                      className="relative flex flex-1 items-center justify-center gap-1.5 rounded-xl py-2 text-xs font-semibold transition-colors"
                      style={{ color: isActive ? '#00c6ff' : 'rgba(148,163,184,0.6)' }}
                    >
                      {isActive && (
                        <motion.div
                          layoutId="admin-tab-bg"
                          className="absolute inset-0 rounded-xl"
                          style={{ background: 'rgba(0,198,255,0.1)', border: '1px solid rgba(0,198,255,0.2)' }}
                          transition={{ type: 'spring', stiffness: 350, damping: 30 }}
                        />
                      )}
                      <Icon size={13} className="relative z-10" />
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
