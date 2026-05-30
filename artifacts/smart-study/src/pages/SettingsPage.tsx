import { motion, AnimatePresence } from 'framer-motion';
import { useState } from 'react';
import { ChevronLeft, Globe, BookOpen, Type, Bell, Info, Moon, ChevronRight, Check, Database, Key, Eye, EyeOff, X, CheckCircle2, AlertCircle } from 'lucide-react';
import { useAppStore, Settings } from '../store/useAppStore';
import { useAuth } from '../contexts/AuthContext';
import { saveSettings } from '../lib/firestore';
import PageWrapper from '../components/layout/PageWrapper';
import GlassCard from '../components/ui/GlassCard';

const API_KEY_STORAGE = 'sage_gemini_api_key';

function ApiKeyModal({ onClose }: { onClose: () => void }) {
  const saved = localStorage.getItem(API_KEY_STORAGE) ?? '';
  const [key, setKey] = useState(saved);
  const [show, setShow] = useState(false);
  const [saved2, setSaved2] = useState(false);

  const handleSave = () => {
    const trimmed = key.trim();
    if (trimmed) {
      localStorage.setItem(API_KEY_STORAGE, trimmed);
    } else {
      localStorage.removeItem(API_KEY_STORAGE);
    }
    setSaved2(true);
    setTimeout(() => { setSaved2(false); onClose(); }, 1200);
  };

  const handleClear = () => {
    setKey('');
    localStorage.removeItem(API_KEY_STORAGE);
  };

  const hasSaved = !!localStorage.getItem(API_KEY_STORAGE);
  const masked = saved ? `${saved.slice(0, 8)}${'•'.repeat(20)}` : '';

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-end"
      style={{ background: 'rgba(0,0,0,0.75)' }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <motion.div
        initial={{ y: '100%' }}
        animate={{ y: 0 }}
        exit={{ y: '100%' }}
        transition={{ type: 'spring', stiffness: 300, damping: 30 }}
        className="w-full rounded-t-3xl p-6 pb-10"
        style={{ background: '#0d1426', border: '1px solid rgba(255,255,255,0.08)', borderBottom: 'none' }}
      >
        <div className="mb-5 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl" style={{ background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.2)' }}>
              <Key size={16} className="text-amber-400" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white">Gemini API Key</h2>
              <p className="text-[11px] text-slate-500">مفتاح Google AI Studio</p>
            </div>
          </div>
          <motion.button whileTap={{ scale: 0.9 }} onClick={onClose}>
            <X size={20} className="text-slate-500" />
          </motion.button>
        </div>

        {hasSaved && !key && (
          <div className="mb-4 flex items-center gap-2.5 rounded-xl px-3.5 py-3" style={{ background: 'rgba(52,211,153,0.07)', border: '1px solid rgba(52,211,153,0.18)' }}>
            <CheckCircle2 size={14} className="text-emerald-400 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-emerald-400">مفتاح محفوظ</p>
              <p className="text-[11px] text-slate-500 font-mono truncate mt-0.5">{masked}</p>
            </div>
            <motion.button
              whileTap={{ scale: 0.9 }}
              onClick={handleClear}
              className="text-[11px] text-red-400 flex-shrink-0"
            >
              حذف
            </motion.button>
          </div>
        )}

        <div className="mb-3">
          <label className="mb-1.5 block text-xs font-medium text-slate-400">
            {hasSaved ? 'تحديث المفتاح' : 'أدخل مفتاح API'}
          </label>
          <div className="relative flex items-center">
            <input
              type={show ? 'text' : 'password'}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="AIza..."
              className="w-full rounded-xl p-3 pr-11 font-mono text-sm text-white placeholder-slate-600 outline-none"
              style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}
              autoComplete="off"
              spellCheck={false}
            />
            <motion.button
              whileTap={{ scale: 0.9 }}
              onClick={() => setShow((s) => !s)}
              className="absolute left-3"
            >
              {show ? <EyeOff size={15} className="text-slate-500" /> : <Eye size={15} className="text-slate-500" />}
            </motion.button>
          </div>
        </div>

        <div className="mb-4 flex items-start gap-2 rounded-xl px-3 py-2.5" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
          <AlertCircle size={13} className="text-slate-500 flex-shrink-0 mt-0.5" />
          <p className="text-[11px] text-slate-500 leading-relaxed">
            المفتاح يُحفظ في المتصفح فقط ولا يُرسل لأي خادم.
            احصل على مفتاح مجاني من{' '}
            <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer" className="text-[#00c6ff] underline">
              Google AI Studio
            </a>
          </p>
        </div>

        <motion.button
          whileTap={{ scale: 0.97 }}
          onClick={handleSave}
          className="w-full rounded-2xl py-3.5 text-sm font-semibold text-white flex items-center justify-center gap-2"
          style={{
            background: saved2
              ? 'linear-gradient(135deg, #059669, #10b981)'
              : 'linear-gradient(135deg, #0090ff, #00c6ff)',
            boxShadow: saved2 ? '0 4px 16px rgba(16,185,129,0.3)' : '0 4px 16px rgba(0,144,255,0.3)',
          }}
        >
          {saved2 ? (
            <><CheckCircle2 size={16} /> تم الحفظ!</>
          ) : (
            <><Key size={15} /> حفظ المفتاح</>
          )}
        </motion.button>
      </motion.div>
    </motion.div>
  );
}

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

const LANGUAGES = ['English', 'Spanish', 'French', 'German', 'Japanese', 'Arabic'];
const FONT_SIZES = ['small', 'medium', 'large'] as const;

export default function SettingsPage() {
  const { settings, updateSettings, setPage } = useAppStore();
  const { user } = useAuth();
  const [showApiKey, setShowApiKey] = useState(false);
  const hasApiKey = !!(import.meta.env.VITE_GEMINI_API_KEY || localStorage.getItem(API_KEY_STORAGE));

  const handleUpdateSettings = (updates: Partial<Settings>) => {
    updateSettings(updates);
    if (user?.uid) {
      saveSettings(user.uid, { ...settings, ...updates }).catch((err) =>
        console.error('[Firestore] Failed to save settings:', err)
      );
    }
  };

  return (
    <PageWrapper>
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
              <motion.button
                whileTap={{ scale: 0.99 }}
                onClick={() => setShowApiKey(true)}
                className="flex w-full items-center gap-3 px-4 py-3.5 text-left"
              >
                <div
                  className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl"
                  style={{ background: 'rgba(245,158,11,0.1)' }}
                >
                  <Key size={16} style={{ color: '#f59e0b' }} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-white">Gemini API Key</p>
                  <p className="text-[11px] text-slate-500">
                    {hasApiKey ? 'مفتاح مفعّل ✓' : 'لم يُضف مفتاح بعد'}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <div
                    className="h-2 w-2 rounded-full flex-shrink-0"
                    style={{
                      background: hasApiKey ? '#34d399' : '#f87171',
                      boxShadow: hasApiKey ? '0 0 6px rgba(52,211,153,0.8)' : '0 0 6px rgba(248,113,113,0.6)',
                    }}
                  />
                  <ChevronRight size={14} className="text-slate-600" />
                </div>
              </motion.button>
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
        </div>
      </div>

      <AnimatePresence>
        {showApiKey && <ApiKeyModal onClose={() => setShowApiKey(false)} />}
      </AnimatePresence>
    </PageWrapper>
  );
}
