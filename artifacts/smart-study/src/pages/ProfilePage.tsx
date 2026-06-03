import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { User, Flame, BookOpen, Timer, Edit3, Check, Target, GraduationCap, X, Settings, LogOut, Zap, Globe, MapPin } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { useAuth } from '../contexts/AuthContext';
import { saveUserProfile } from '../lib/firestore';
import { getDateForCountry, getLast28Days } from '../lib/streakEngine';
import PageWrapper from '../components/layout/PageWrapper';
import GlassCard from '../components/ui/GlassCard';

const AVATARS = ['🧠', '🎓', '🚀', '⚡', '🌟', '🔥', '💡', '🎯'];
const CURRICULA = ['STEM', 'Arts & Humanities', 'Business', 'Medicine', 'Law', 'Engineering', 'Computer Science', 'Social Sciences'];

// ─── Student context helpers ──────────────────────────────────────────────────

const COUNTRY_LABELS: Record<string, string> = {
  egypt: '🇪🇬 مصر',
  sudan: '🇸🇩 السودان',
};

const LEVEL_LABELS: Record<string, string> = {
  primary: 'المرحلة الابتدائية',
  preparatory: 'المرحلة الإعدادية',
  secondary: 'المرحلة الثانوية',
};

const TRACK_LABELS: Record<string, string> = {
  scientific: 'علمي',
  literary: 'أدبي',
};

function buildStudentContextLine(
  country: string,
  level: string,
  track: string
): string {
  const parts: string[] = [];
  if (country && COUNTRY_LABELS[country]) parts.push(COUNTRY_LABELS[country]);
  if (level && LEVEL_LABELS[level]) parts.push(LEVEL_LABELS[level]);
  if (track && TRACK_LABELS[track]) parts.push(TRACK_LABELS[track]);
  return parts.join(' · ');
}

// ─────────────────────────────────────────────────────────────────────────────

function StatCard({ icon: Icon, value, label, color }: { icon: typeof Flame; value: string | number; label: string; color: string }) {
  return (
    <motion.div
      whileHover={{ y: -2 }}
      className="flex flex-1 flex-col items-center gap-1 rounded-2xl p-3"
      style={{
        background: `${color}10`,
        border: `1px solid ${color}25`,
      }}
    >
      <Icon size={18} style={{ color }} strokeWidth={1.8} />
      <span className="text-xl font-bold text-white">{value}</span>
      <span className="text-[10px] text-slate-500 text-center leading-tight">{label}</span>
    </motion.div>
  );
}

export default function ProfilePage() {
  const { userProfile, updateProfile, flashcards, tasks, setPage } = useAppStore();
  const gamification = useAppStore((s) => s.gamification);
  const studentProfile = useAppStore((s) => s.studentProfile);
  const { user, logout } = useAuth();
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(userProfile.name);
  const [editGoal, setEditGoal] = useState(userProfile.studyGoal ?? '');
  const [editCurriculum, setEditCurriculum] = useState(userProfile.curriculum ?? '');
  const [editAvatar, setEditAvatar] = useState(userProfile.avatar || '🧠');

  const currentStreak = gamification.currentStreak ?? 0;
  const longestStreak = gamification.longestStreak ?? 0;
  const xp = gamification.xp ?? 0;

  const today = getDateForCountry(studentProfile?.country ?? 'egypt');
  const last28 = getLast28Days(today);
  const historySet = new Set<string>(Array.isArray(gamification.streakHistory) ? gamification.streakHistory : []);

  // ─── Student context derived from profile ──────────────────────────────────
  const country = studentProfile?.country ?? '';
  const level = studentProfile?.level ?? '';
  const track = studentProfile?.track ?? '';
  const hasStudentProfile = !!(country || level);
  const studentContextLine = buildStudentContextLine(country, level, track);

  const handleSave = () => {
    const updates = { name: editName, studyGoal: editGoal, curriculum: editCurriculum, avatar: editAvatar };
    updateProfile(updates);
    if (user?.uid) {
      saveUserProfile(user.uid, updates).catch((err) =>
        console.error('[Firestore] Failed to save user profile:', err)
      );
    }
    setEditing(false);
  };

  const handleCancel = () => {
    setEditName(userProfile.name);
    setEditGoal(userProfile.studyGoal ?? '');
    setEditCurriculum(userProfile.curriculum ?? '');
    setEditAvatar(userProfile.avatar || '🧠');
    setEditing(false);
  };

  const completedTasks = tasks.filter((t) => t.completed).length;

  return (
    <PageWrapper>
      <div className="px-5 pt-14 pb-32">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <p className="text-xs font-medium uppercase tracking-widest text-slate-500">Account</p>
            <h1 className="text-2xl font-bold text-white">Profile</h1>
          </div>
          <div className="flex gap-2">
            <motion.button
              whileTap={{ scale: 0.9 }}
              onClick={() => setPage('settings')}
              className="flex h-9 w-9 items-center justify-center rounded-xl"
              style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)' }}
            >
              <Settings size={16} className="text-slate-400" />
            </motion.button>
            <motion.button
              whileTap={{ scale: 0.9 }}
              onClick={() => setEditing(true)}
              className="flex h-9 items-center gap-1.5 rounded-xl px-3"
              style={{ background: 'rgba(0,198,255,0.1)', border: '1px solid rgba(0,198,255,0.2)' }}
            >
              <Edit3 size={14} className="text-[#00c6ff]" />
              <span className="text-xs font-medium text-[#00c6ff]">Edit</span>
            </motion.button>
            <motion.button
              whileTap={{ scale: 0.9 }}
              onClick={logout}
              className="flex h-9 w-9 items-center justify-center rounded-xl"
              style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.18)' }}
              title="تسجيل الخروج"
            >
              <LogOut size={15} className="text-red-400" />
            </motion.button>
          </div>
        </div>

        {/* Profile Card */}
        <GlassCard className="mb-5 p-5" neon>
          <div className="flex items-center gap-4">
            <motion.div
              whileHover={{ scale: 1.05 }}
              className="flex h-20 w-20 items-center justify-center rounded-3xl text-4xl flex-shrink-0"
              style={{
                background: 'linear-gradient(135deg, rgba(0,198,255,0.15) 0%, rgba(0,144,255,0.1) 100%)',
                border: '2px solid rgba(0,198,255,0.25)',
                boxShadow: '0 0 24px rgba(0,198,255,0.15)',
              }}
            >
              {userProfile.avatar || '🧠'}
            </motion.div>
            <div className="flex-1 min-w-0">
              <h2 className="text-xl font-bold text-white truncate">{userProfile.name}</h2>

              {/* Student context — dynamic from studentProfile */}
              {hasStudentProfile ? (
                <div className="mt-1 flex items-center gap-1.5">
                  <GraduationCap size={13} className="text-[#00c6ff] flex-shrink-0" />
                  <span className="text-xs text-slate-300 truncate">{studentContextLine}</span>
                </div>
              ) : (
                <div className="mt-1 flex items-center gap-1.5">
                  <GraduationCap size={13} className="text-slate-600 flex-shrink-0" />
                  <span className="text-xs text-slate-500">لم يتم تحديد المنهج بعد</span>
                </div>
              )}

              {/* Study goal */}
              <div className="mt-1.5 flex items-center gap-1.5">
                <Target size={13} className="text-amber-400 flex-shrink-0" />
                <span className="text-xs text-slate-400 truncate">
                  {userProfile.studyGoal || 'لم يتم تحديد هدف بعد'}
                </span>
              </div>

              {/* Track badge (secondary level only) */}
              {track && (
                <div className="mt-2">
                  <span
                    className="rounded-lg px-2 py-0.5 text-[10px] font-medium"
                    style={{
                      background: track === 'scientific' ? 'rgba(0,198,255,0.1)' : 'rgba(245,158,11,0.1)',
                      color: track === 'scientific' ? '#7dd3fc' : '#fcd34d',
                      border: track === 'scientific' ? '1px solid rgba(0,198,255,0.2)' : '1px solid rgba(245,158,11,0.2)',
                    }}
                  >
                    {TRACK_LABELS[track]}
                  </span>
                </div>
              )}
            </div>
          </div>
        </GlassCard>

        {/* Stats */}
        <div className="mb-5 flex gap-3">
          <StatCard icon={Flame} value={currentStreak} label="Day Streak" color="#f59e0b" />
          <StatCard icon={Zap} value={xp} label="XP" color="#00c6ff" />
          <StatCard icon={BookOpen} value={flashcards.length} label="Cards" color="#34d399" />
          <StatCard icon={Check} value={completedTasks} label="Tasks Done" color="#f87171" />
        </div>

        {/* 28-day streak grid */}
        <GlassCard className="mb-5 p-4" delay={0.1}>
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-white">Study Streak</h3>
            <div className="flex items-center gap-2">
              <span className="text-xs text-amber-400">{currentStreak} days</span>
              <span className="text-xs text-slate-600">·</span>
              <span className="text-xs text-slate-500">Best: {longestStreak}</span>
            </div>
          </div>
          <div className="flex gap-1.5 flex-wrap">
            {last28.map((day) => {
              const isCompleted = historySet.has(day);
              const isToday = day === today;
              return (
                <motion.div
                  key={day}
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={{ delay: last28.indexOf(day) * 0.015 }}
                  className="h-5 w-5 rounded-md"
                  title={day}
                  style={{
                    background: isCompleted
                      ? isToday
                        ? 'linear-gradient(135deg, #f59e0b, #fbbf24)'
                        : 'rgba(245,158,11,0.45)'
                      : isToday
                        ? 'rgba(0,198,255,0.12)'
                        : 'rgba(255,255,255,0.05)',
                    border: isToday
                      ? isCompleted
                        ? '1px solid rgba(245,158,11,0.6)'
                        : '1px solid rgba(0,198,255,0.25)'
                      : 'none',
                    boxShadow: isToday && isCompleted ? '0 0 8px rgba(245,158,11,0.6)' : 'none',
                  }}
                />
              );
            })}
          </div>
          <p className="mt-2 text-xs text-slate-500">Last 28 days · Complete all 3 daily tasks to earn a streak day</p>
        </GlassCard>

        {/* Knowledge Areas */}
        <GlassCard className="p-4" delay={0.15}>
          <h3 className="mb-3 text-sm font-semibold text-white">Knowledge Areas</h3>
          <div className="space-y-3">
            {Array.from(new Set(flashcards.map((c) => c.category))).slice(0, 4).map((cat, i) => {
              const count = flashcards.filter((c) => c.category === cat).length;
              const pct = Math.min((count / flashcards.length) * 100, 100);
              const colors = ['#00c6ff', '#34d399', '#f59e0b', '#f87171'];
              return (
                <div key={cat}>
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-xs font-medium text-slate-300">{cat}</span>
                    <span className="text-xs text-slate-500">{count} cards</span>
                  </div>
                  <div className="h-1.5 w-full rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
                    <motion.div
                      initial={{ width: 0 }}
                      animate={{ width: `${pct}%` }}
                      transition={{ duration: 1, delay: i * 0.1 + 0.3 }}
                      className="h-full rounded-full"
                      style={{ background: colors[i % colors.length] }}
                    />
                  </div>
                </div>
              );
            })}
            {flashcards.length === 0 && (
              <p className="text-xs text-slate-500 text-center py-2">Create flashcards to see your knowledge areas</p>
            )}
          </div>
        </GlassCard>
      </div>

      {/* Edit Modal */}
      <AnimatePresence>
        {editing && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-end"
            style={{ background: 'rgba(0,0,0,0.7)' }}
            onClick={(e) => e.target === e.currentTarget && handleCancel()}
          >
            <motion.div
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', stiffness: 300, damping: 30 }}
              className="w-full rounded-t-3xl p-6 pb-10 overflow-y-auto max-h-[90vh]"
              style={{ background: '#0d1426', border: '1px solid rgba(255,255,255,0.08)', borderBottom: 'none' }}
            >
              <div className="mb-5 flex items-center justify-between">
                <h2 className="text-lg font-bold text-white">Edit Profile</h2>
                <motion.button whileTap={{ scale: 0.9 }} onClick={handleCancel}>
                  <X size={20} className="text-slate-400" />
                </motion.button>
              </div>

              <div className="mb-4">
                <label className="mb-2 block text-xs font-medium text-slate-400">Avatar</label>
                <div className="flex flex-wrap gap-2">
                  {AVATARS.map((av) => (
                    <motion.button
                      key={av}
                      whileTap={{ scale: 0.88 }}
                      onClick={() => setEditAvatar(av)}
                      className="flex h-12 w-12 items-center justify-center rounded-2xl text-2xl transition-all"
                      style={{
                        background: editAvatar === av ? 'rgba(0,198,255,0.15)' : 'rgba(255,255,255,0.04)',
                        border: editAvatar === av ? '2px solid rgba(0,198,255,0.5)' : '1px solid rgba(255,255,255,0.08)',
                      }}
                    >
                      {av}
                    </motion.button>
                  ))}
                </div>
              </div>

              <div className="space-y-3">
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-400">Name</label>
                  <input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className="w-full rounded-xl p-3 text-sm text-white outline-none"
                    style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-400">Study Goal</label>
                  <input
                    value={editGoal}
                    onChange={(e) => setEditGoal(e.target.value)}
                    className="w-full rounded-xl p-3 text-sm text-white outline-none"
                    style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}
                  />
                </div>
                <div>
                  <label className="mb-2 block text-xs font-medium text-slate-400">Curriculum</label>
                  <div className="grid grid-cols-2 gap-2">
                    {CURRICULA.map((cur) => (
                      <motion.button
                        key={cur}
                        whileTap={{ scale: 0.96 }}
                        onClick={() => setEditCurriculum(cur)}
                        className="rounded-xl px-3 py-2.5 text-xs font-medium transition-all text-left"
                        style={{
                          background: editCurriculum === cur ? 'rgba(0,198,255,0.15)' : 'rgba(255,255,255,0.04)',
                          border: editCurriculum === cur ? '1px solid rgba(0,198,255,0.35)' : '1px solid rgba(255,255,255,0.07)',
                          color: editCurriculum === cur ? '#00c6ff' : '#94a3b8',
                        }}
                      >
                        {cur}
                      </motion.button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="mt-5 flex gap-3">
                <motion.button
                  whileTap={{ scale: 0.97 }}
                  onClick={handleCancel}
                  className="flex-1 rounded-2xl py-3.5 text-sm font-semibold text-slate-400"
                  style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)' }}
                >
                  Cancel
                </motion.button>
                <motion.button
                  whileTap={{ scale: 0.97 }}
                  onClick={handleSave}
                  className="flex-1 rounded-2xl py-3.5 text-sm font-semibold text-white"
                  style={{ background: 'linear-gradient(135deg, #0090ff, #00c6ff)', boxShadow: '0 4px 16px rgba(0,144,255,0.3)' }}
                >
                  Save Changes
                </motion.button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </PageWrapper>
  );
}
