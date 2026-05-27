import { useState } from 'react';
import { motion } from 'framer-motion';
import { Brain, ChevronDown, ArrowRight } from 'lucide-react';
import { useAppStore, Country, Level, Track } from '../store/useAppStore';
import { useAuth } from '../contexts/AuthContext';
import { saveStudentProfile } from '../lib/firestore';

const countries: { value: Country; label: string; flag: string }[] = [
  { value: 'egypt', label: 'مصر', flag: '🇪🇬' },
  { value: 'sudan', label: 'السودان', flag: '🇸🇩' },
];

const levels: { value: Level; label: string }[] = [
  { value: 'primary', label: 'المرحلة الابتدائية' },
  { value: 'preparatory', label: 'المرحلة الإعدادية' },
  { value: 'secondary', label: 'المرحلة الثانوية' },
];

const tracks: { value: Track; label: string }[] = [
  { value: 'scientific', label: 'العلمي' },
  { value: 'literary', label: 'الأدبي' },
];

interface SelectFieldProps {
  label: string;
  value: string;
  placeholder: string;
  options: { value: string; label: string; flag?: string }[];
  onChange: (val: string) => void;
}

function SelectField({ label, value, placeholder, options, onChange }: SelectFieldProps) {
  const [open, setOpen] = useState(false);
  const selected = options.find((o) => o.value === value);

  return (
    <div className="flex flex-col gap-2">
      <label className="text-xs font-semibold tracking-widest uppercase text-slate-400">{label}</label>
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen((p) => !p)}
          className="flex w-full items-center justify-between rounded-2xl px-4 py-3.5 text-sm transition-all"
          style={{
            background: open
              ? 'rgba(0,198,255,0.08)'
              : 'rgba(255,255,255,0.04)',
            border: open
              ? '1px solid rgba(0,198,255,0.35)'
              : '1px solid rgba(255,255,255,0.08)',
            color: selected ? '#f1f5f9' : '#64748b',
          }}
        >
          <span>
            {selected ? (
              <span>
                {selected.flag && <span className="mr-2">{selected.flag}</span>}
                {selected.label}
              </span>
            ) : (
              placeholder
            )}
          </span>
          <motion.div
            animate={{ rotate: open ? 180 : 0 }}
            transition={{ duration: 0.2 }}
          >
            <ChevronDown size={16} className="text-slate-500" />
          </motion.div>
        </button>

        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-2xl"
            style={{
              background: '#0d1b2e',
              border: '1px solid rgba(0,198,255,0.2)',
              boxShadow: '0 16px 48px rgba(0,0,0,0.6)',
            }}
          >
            {options.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => { onChange(opt.value); setOpen(false); }}
                className="flex w-full items-center gap-2 px-4 py-3 text-sm text-left transition-colors"
                style={{
                  color: opt.value === value ? '#00c6ff' : '#cbd5e1',
                  background: opt.value === value ? 'rgba(0,198,255,0.08)' : 'transparent',
                }}
              >
                {opt.flag && <span>{opt.flag}</span>}
                {opt.label}
              </button>
            ))}
          </motion.div>
        )}
      </div>
    </div>
  );
}

export default function ProfileSetupScreen() {
  const setStudentProfile = useAppStore((s) => s.setStudentProfile);
  const setPage = useAppStore((s) => s.setPage);

  const [country, setCountry] = useState<Country | ''>('');
  const [level, setLevel] = useState<Level | ''>('');
  const [track, setTrack] = useState<Track | ''>('');

  const isSecondary = level === 'secondary';
  const canSave =
    country !== '' && level !== '' && (isSecondary ? track !== '' : true);

  const { user } = useAuth();

  const handleSave = async () => {
    if (!canSave) return;
    const profile = {
      country: country as Country,
      level: level as Level,
      track: isSecondary ? (track as Track) : '' as Track,
    };
    setStudentProfile(profile);
    if (user?.uid) {
      await saveStudentProfile(user.uid, { ...profile, profileComplete: true });
    }
    setPage('home');
  };

  return (
    <div
      className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden px-6"
      style={{ background: 'linear-gradient(135deg, #060b18 0%, #0a1628 50%, #060b18 100%)' }}
    >
      <div
        className="absolute left-1/2 top-1/3 -translate-x-1/2 -translate-y-1/2 rounded-full pointer-events-none"
        style={{
          width: '500px',
          height: '500px',
          background: 'radial-gradient(circle, rgba(0,198,255,0.05) 0%, transparent 70%)',
        }}
      />

      <div className="relative z-10 w-full max-w-sm">
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: 'easeOut' }}
          className="flex flex-col items-center gap-2 mb-8"
        >
          <div
            className="flex h-16 w-16 items-center justify-center rounded-3xl mb-3"
            style={{
              background: 'linear-gradient(135deg, rgba(0,198,255,0.15) 0%, rgba(0,144,255,0.1) 100%)',
              border: '1px solid rgba(0,198,255,0.3)',
              boxShadow: '0 0 30px rgba(0,198,255,0.15)',
            }}
          >
            <Brain size={32} className="text-[#00c6ff]" strokeWidth={1.5} />
          </div>
          <h1
            className="text-2xl font-bold"
            style={{
              background: 'linear-gradient(135deg, #ffffff 0%, #00c6ff 60%)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              backgroundClip: 'text',
            }}
          >
            أهلاً بك في Sage
          </h1>
          <p className="text-sm text-slate-400 text-center leading-relaxed">
            أخبرنا عن نفسك حتى نخصص تجربتك الدراسية
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 32 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.1, ease: 'easeOut' }}
          className="flex flex-col gap-5"
        >
          <div
            className="flex flex-col gap-5 rounded-3xl p-5"
            style={{
              background: 'rgba(255,255,255,0.03)',
              border: '1px solid rgba(255,255,255,0.07)',
            }}
          >
            <SelectField
              label="الدولة"
              value={country}
              placeholder="اختر دولتك"
              options={countries}
              onChange={(v) => setCountry(v as Country)}
            />

            <SelectField
              label="المرحلة الدراسية"
              value={level}
              placeholder="اختر مرحلتك"
              options={levels}
              onChange={(v) => { setLevel(v as Level); setTrack(''); }}
            />

            {isSecondary && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.25 }}
              >
                <SelectField
                  label="الشعبة"
                  value={track}
                  placeholder="اختر شعبتك"
                  options={tracks}
                  onChange={(v) => setTrack(v as Track)}
                />
              </motion.div>
            )}
          </div>

          <motion.button
            whileTap={{ scale: 0.97 }}
            onClick={handleSave}
            disabled={!canSave}
            className="flex w-full items-center justify-center gap-2 rounded-2xl py-4 text-sm font-bold transition-all"
            style={
              canSave
                ? {
                    background: 'linear-gradient(135deg, #0090ff 0%, #0070c0 100%)',
                    boxShadow: '0 8px 24px rgba(0,144,255,0.35)',
                    color: '#fff',
                  }
                : {
                    background: 'rgba(255,255,255,0.05)',
                    color: '#475569',
                    cursor: 'not-allowed',
                    border: '1px solid rgba(255,255,255,0.06)',
                  }
            }
          >
            ابدأ الدراسة
            <ArrowRight size={16} />
          </motion.button>
        </motion.div>
      </div>
    </div>
  );
}
