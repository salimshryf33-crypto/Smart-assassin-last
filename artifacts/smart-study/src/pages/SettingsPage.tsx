import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronLeft, Globe, BookOpen, Type, Bell, Info, Moon, ChevronRight, Check, Database, Key, CheckCircle2, Trash2, AlertTriangle } from 'lucide-react';
import { useAppStore, Settings } from '../store/useAppStore';
import { useAuth } from '../contexts/AuthContext';
import { saveSettings } from '../lib/firestore';
import PageWrapper from '../components/layout/PageWrapper';
import GlassCard from '../components/ui/GlassCard';

function ToggleSwitch({ enabled, onChange }: { enabled: boolean; onChange: (v: boolean) => void }) {
  return (
    <motion.button
      whileTap={{ scale: 0.95 }}
      onClick={() => onChange(!enabled)}
      className="relative flex h-7 w-12 items-center rounded-full transition-colors duration-300 flex-shrink-0"
      style={{
        background: enabled
          ? 'linear-gradient(135deg, #0090ff, #00c6ff)'
          : 'rgba(255,255,255,0.1)',
        boxShadow: enabled ? '0 0 12px rgba(0,198,255,0.3)' : 'none',
      }}
    >
      <motion.div
        animate={{ x: enabled ? 22 : 2 }}
        transition={{ type: 'spring', stiffness: 400, damping: 25 }}
        className="h-5 w-5 rounded-full bg-white"
        style={{ boxShadow: '0 1px 4px rgba(0,0,0,0.3)' }}
      />
    </motion.button>
  );
}

function SettingRow({
  icon: Icon,
  iconColor,
  iconBg,
  label,
  description,
  right,
}: {
  icon: typeof Globe;
  iconColor: string;
  iconBg: string;
  label: string;
  description?: string;
  right: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 py-3.5 px-4">
      <div
        className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl"
        style={{ background: iconBg }}
      >
        <Icon size={16} style={{ color: iconColor }} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-white">{label}</p>
        {description && <p className="text-[11px] text-slate-500 mt-0.5 truncate">{description}</p>}
      </div>
      <div className="flex-shrink-0">{right}</div>
    </div>
  );
}

// ─── Delete Account Modal ──────────────────────────────────────────────────────

function DeleteAccountModal({
  onConfirm,
  onCancel,
  loading,
  error,
}: {
  onConfirm: () => void;
  onCancel: () => void;
  loading: boolean;
  error: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center px-6"
      style={{ background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(8px)' }}
    >
      <motion.div
        initial={{ scale: 0.9, opacity: 0, y: 20 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.9, opacity: 0 }}
        className="w-full max-w-sm rounded-3xl p-6"
        style={{
          background: 'linear-gradient(135deg, #0d1424 0%, #111827 100%)',
          border: '1px solid rgba(248,113,113,0.2)',
          boxShadow: '0 0 40px rgba(248,113,113,0.1)',
        }}
      >
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl mx-auto"
          style={{ background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.2)' }}>
          <AlertTriangle size={22} className="text-red-400" />
        </div>
        <h2 className="text-center text-lg font-bold text-white mb-1">حذف الحساب نهائياً</h2>
        <p className="text-center text-xs text-slate-400 mb-5 leading-relaxed">
          سيتم حذف جميع بياناتك نهائياً بما فيها البطاقات والنقاط والتقدم الدراسي.
          <span className="text-red-400 font-semibold"> لا يمكن التراجع عن هذه الخطوة.</span>
        </p>

        {error && (
          <div className="mb-4 rounded-xl px-3 py-2.5 text-xs text-red-400"
            style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)' }}>
            {error}
          </div>
        )}

        <div className="flex flex-col gap-2">
          <motion.button
            whileTap={{ scale: 0.97 }}
            onClick={onConfirm}
            disabled={loading}
            className="w-full rounded-2xl py-3.5 text-sm font-bold text-white transition-all"
            style={{
              background: loading ? 'rgba(248,113,113,0.1)' : 'linear-gradient(135deg, #dc2626, #b91c1c)',
              boxShadow: loading ? 'none' : '0 8px 20px rgba(220,38,38,0.3)',
            }}
          >
            {loading ? 'جارٍ الحذف...' : 'نعم، احذف حسابي'}
          </motion.button>
          <motion.button
            whileTap={{ scale: 0.97 }}
            onClick={onCancel}
            disabled={loading}
            className="w-full rounded-2xl py-3.5 text-sm font-semibold text-slate-400 transition-all"
            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}
          >
            إلغاء
          </motion.button>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

const LANGUAGES = ['English', 'Spanish', 'French', 'German', 'Japanese', 'Arabic'];
const FONT_SIZES = ['small', 'medium', 'large'] as const;

export default function SettingsPage() {
  const { settings, updateSettings, setPage } = useAppStore();
  const { user, deleteAccount } = useAuth();

  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  const handleUpdateSettings = (updates: Partial<Settings>) => {
    updateSettings(updates);
    if (user?.uid) {
      saveSettings(user.uid, { ...settings, ...updates }).catch((err) =>
        console.error('[Firestore] Failed to save settings:', err)
      );
    }
  };

  const handleDeleteAccount = async () => {
    setDeleteLoading(true);
    setDeleteError('');
    try {
      await deleteAccount();
      // onAuthStateChanged will reset store and navigate to login automatically
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code ?? '';
      if (code === 'auth/requires-recent-login') {
        setDeleteError('لأسباب أمنية، يرجى تسجيل الخروج وإعادة الدخول ثم المحاولة مجدداً.');
      } else if (code) {
        setDeleteError(`فشل الحذف. (${code})`);
      } else {
        setDeleteError('فشل الحذف. حاول مجدداً.');
      }
      setDeleteLoading(false);
    }
  };

  return (
    <PageWrapper>
      <AnimatePresence>
        {showDeleteModal && (
          <DeleteAccountModal
            onConfirm={handleDeleteAccount}
            onCancel={() => { setShowDeleteModal(false); setDeleteError(''); }}
            loading={deleteLoading}
            error={deleteError}
          />
        )}
      </AnimatePresence>

      <div className="px-5 pt-14 pb-32">
        <div className="mb-6 flex items-center gap-3">
          <motion.button
            whileTap={{ scale: 0.9 }}
            onClick={() => setPage('home')}
            className="flex h-9 w-9 items-center justify-center rounded-xl"
            style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)' }}
          >
            <ChevronLeft size={18} className="text-slate-400" />
          </motion.button>
          <div>
            <p className="text-xs font-medium uppercase tracking-widest text-slate-500">Preferences</p>
            <h1 className="text-2xl font-bold text-white">Settings</h1>
          </div>
        </div>

        <div className="space-y-4">
          <div>
            <p className="mb-2 px-1 text-xs font-semibold uppercase tracking-wider text-slate-500">Appearance</p>
            <GlassCard className="overflow-hidden divide-y divide-white/[0.04]">
              <SettingRow
                icon={Moon}
                iconColor="#38bdf8"
                iconBg="rgba(56,189,248,0.1)"
                label="Dark Mode"
                description="Futuristic dark theme"
                right={
                  <ToggleSwitch
                    enabled={settings.darkMode}
                    onChange={(v) => handleUpdateSettings({ darkMode: v })}
                  />
                }
              />
              <div className="px-4 py-3.5">
                <div className="flex items-center gap-3 mb-3">
                  <div
                    className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl"
                    style={{ background: 'rgba(245,158,11,0.1)' }}
                  >
                    <Type size={16} style={{ color: '#f59e0b' }} />
                  </div>
                  <div className="flex-1">
                    <p className="text-sm font-medium text-white">Font Size</p>
                    <p className="text-[11px] text-slate-500">{settings.fontSize}</p>
                  </div>
                </div>
                <div className="flex gap-2">
                  {FONT_SIZES.map((size) => (
                    <motion.button
                      key={size}
                      whileTap={{ scale: 0.93 }}
                      onClick={() => handleUpdateSettings({ fontSize: size })}
                      className="flex flex-1 items-center justify-center gap-1.5 rounded-xl py-2 text-xs font-medium capitalize transition-all"
                      style={{
                        background: settings.fontSize === size ? 'rgba(245,158,11,0.15)' : 'rgba(255,255,255,0.04)',
                        border: settings.fontSize === size ? '1px solid rgba(245,158,11,0.35)' : '1px solid rgba(255,255,255,0.07)',
                        color: settings.fontSize === size ? '#f59e0b' : '#64748b',
                      }}
                    >
                      {settings.fontSize === size && <Check size={11} />}
                      {size}
                    </motion.button>
                  ))}
                </div>
              </div>
            </GlassCard>
          </div>

          <div>
            <p className="mb-2 px-1 text-xs font-semibold uppercase tracking-wider text-slate-500">Study</p>
            <GlassCard className="overflow-hidden divide-y divide-white/[0.04]">
              <div className="px-4 py-3.5">
                <div className="flex items-center gap-3 mb-3">
                  <div
                    className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl"
                    style={{ background: 'rgba(0,198,255,0.1)' }}
                  >
                    <BookOpen size={16} style={{ color: '#00c6ff' }} />
                  </div>
                  <div className="flex-1">
                    <p className="text-sm font-medium text-white">Curriculum</p>
                    <p className="text-[11px] text-slate-500">{settings.curriculum}</p>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  {['STEM', 'Arts & Humanities', 'Business', 'Medicine'].map((cur) => (
                    <motion.button
                      key={cur}
                      whileTap={{ scale: 0.95 }}
                      onClick={() => handleUpdateSettings({ curriculum: cur })}
                      className="rounded-xl px-3 py-2 text-xs font-medium transition-all text-left"
                      style={{
                        background: settings.curriculum === cur ? 'rgba(0,198,255,0.12)' : 'rgba(255,255,255,0.04)',
                        border: settings.curriculum === cur ? '1px solid rgba(0,198,255,0.3)' : '1px solid rgba(255,255,255,0.06)',
                        color: settings.curriculum === cur ? '#00c6ff' : '#64748b',
                      }}
                    >
                      {cur}
                    </motion.button>
                  ))}
                </div>
              </div>
            </GlassCard>
          </div>

          <div>
            <p className="mb-2 px-1 text-xs font-semibold uppercase tracking-wider text-slate-500">Language</p>
            <GlassCard className="overflow-hidden divide-y divide-white/[0.04]">
              {LANGUAGES.map((lang) => (
                <motion.button
                  key={lang}
                  whileTap={{ scale: 0.99 }}
                  onClick={() => handleUpdateSettings({ language: lang })}
                  className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors duration-200"
                  style={{ background: settings.language === lang ? 'rgba(0,198,255,0.04)' : 'transparent' }}
                >
                  <Globe size={14} className="text-slate-500 flex-shrink-0" />
                  <span className={`flex-1 text-sm ${settings.language === lang ? 'text-white font-medium' : 'text-slate-400'}`}>
                    {lang}
                  </span>
                  {settings.language === lang && (
                    <Check size={14} className="text-[#00c6ff]" />
                  )}
                </motion.button>
              ))}
            </GlassCard>
          </div>

          <div>
            <p className="mb-2 px-1 text-xs font-semibold uppercase tracking-wider text-slate-500">Notifications</p>
            <GlassCard className="overflow-hidden divide-y divide-white/[0.04]">
              <SettingRow
                icon={Bell}
                iconColor="#f59e0b"
                iconBg="rgba(245,158,11,0.1)"
                label="Push Notifications"
                description="Study reminders and alerts"
                right={
                  <ToggleSwitch
                    enabled={settings.notifications}
                    onChange={(v) => handleUpdateSettings({ notifications: v })}
                  />
                }
              />
            </GlassCard>
          </div>

          <div>
            <p className="mb-2 px-1 text-xs font-semibold uppercase tracking-wider text-slate-500">المنهج الدراسي</p>
            <GlassCard className="overflow-hidden divide-y divide-white/[0.04]">
              <motion.button
                whileTap={{ scale: 0.99 }}
                onClick={() => setPage('curriculum-manager')}
                className="flex w-full items-center gap-3 px-4 py-3.5 text-left"
              >
                <div
                  className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl"
                  style={{ background: 'rgba(0,198,255,0.1)' }}
                >
                  <Database size={16} style={{ color: '#00c6ff' }} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-white">إدارة كتب المنهج</p>
                  <p className="text-[11px] text-slate-500">ارفع PDF الكتب لتفعيل التدريس المبني على المنهج</p>
                </div>
                <ChevronRight size={14} className="text-slate-600 flex-shrink-0" />
              </motion.button>
            </GlassCard>
          </div>

          <div>
            <p className="mb-2 px-1 text-xs font-semibold uppercase tracking-wider text-slate-500">AI Integration</p>
            <GlassCard className="overflow-hidden divide-y divide-white/[0.04]">
              <div className="flex items-center gap-3 px-4 py-3.5">
                <div
                  className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl"
                  style={{ background: 'rgba(245,158,11,0.1)' }}
                >
                  <Key size={16} style={{ color: '#f59e0b' }} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-white">Gemini AI</p>
                  <p className="text-[11px] text-slate-500">مفعّل عبر الخادم</p>
                </div>
                <div className="flex items-center gap-2">
                  <CheckCircle2 size={16} className="text-emerald-400" />
                </div>
              </div>
            </GlassCard>
          </div>

          <div>
            <p className="mb-2 px-1 text-xs font-semibold uppercase tracking-wider text-slate-500">About</p>
            <GlassCard className="overflow-hidden divide-y divide-white/[0.04]">
              <SettingRow
                icon={Info}
                iconColor="#64748b"
                iconBg="rgba(100,116,139,0.1)"
                label="Smart Study Assistant"
                description="Version 1.0.0 · Phase 1 MVP"
                right={<ChevronRight size={14} className="text-slate-600" />}
              />
            </GlassCard>
          </div>

          {/* Danger Zone */}
          <div>
            <p className="mb-2 px-1 text-xs font-semibold uppercase tracking-wider text-red-500/70">Danger Zone</p>
            <GlassCard className="overflow-hidden"
              style={{ border: '1px solid rgba(248,113,113,0.15)' } as React.CSSProperties}>
              <motion.button
                whileTap={{ scale: 0.98 }}
                onClick={() => setShowDeleteModal(true)}
                className="flex w-full items-center gap-3 px-4 py-3.5 text-left"
              >
                <div
                  className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl"
                  style={{ background: 'rgba(248,113,113,0.1)' }}
                >
                  <Trash2 size={16} className="text-red-400" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-red-400">حذف الحساب</p>
                  <p className="text-[11px] text-slate-500">حذف نهائي لجميع البيانات</p>
                </div>
              </motion.button>
            </GlassCard>
          </div>
        </div>
      </div>
    </PageWrapper>
  );
}
