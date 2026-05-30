import { motion, AnimatePresence } from 'framer-motion';
import { Flame, X, Zap } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useAppStore } from '../store/useAppStore';
import { markTooltipSeen } from '../lib/gamification';

export default function StreakTooltip() {
  const { user } = useAuth();
  const gamification = useAppStore((s) => s.gamification);
  const updateGamification = useAppStore((s) => s.updateGamification);

  const visible = !gamification.hasSeenStreakTooltip;

  const handleDismiss = async () => {
    updateGamification({ hasSeenStreakTooltip: true });
    if (user?.uid) {
      await markTooltipSeen(user.uid);
    }
  };

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, y: 40, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 20, scale: 0.97 }}
          transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
          className="fixed bottom-24 left-4 right-4 z-50 mx-auto max-w-md"
        >
          <div
            className="relative overflow-hidden rounded-2xl p-5"
            style={{
              background: 'linear-gradient(135deg, rgba(15,20,40,0.98) 0%, rgba(10,15,30,0.98) 100%)',
              border: '1px solid rgba(251,191,36,0.3)',
              boxShadow: '0 20px 60px rgba(0,0,0,0.6), 0 0 40px rgba(251,191,36,0.08)',
            }}
          >
            <div
              className="absolute -right-8 -top-8 h-32 w-32 opacity-10"
              style={{ background: 'radial-gradient(circle, rgba(251,191,36,1) 0%, transparent 70%)' }}
            />

            <button
              onClick={handleDismiss}
              className="absolute right-3 top-3 flex h-7 w-7 items-center justify-center rounded-lg"
              style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)' }}
            >
              <X size={14} className="text-slate-400" />
            </button>

            <div className="flex items-start gap-4">
              <motion.div
                animate={{ scale: [1, 1.15, 1] }}
                transition={{ duration: 1.8, repeat: Infinity }}
                className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-2xl"
                style={{
                  background: 'linear-gradient(135deg, rgba(251,191,36,0.25) 0%, rgba(245,158,11,0.15) 100%)',
                  border: '1px solid rgba(251,191,36,0.35)',
                }}
              >
                <Flame size={24} className="text-amber-400" />
              </motion.div>

              <div className="flex-1 pr-6">
                <h3 className="mb-1.5 text-base font-bold text-white">
                  🔥 ابدأ سلسلة الدراسة اليومية!
                </h3>
                <p className="text-sm leading-relaxed text-slate-300" dir="rtl">
                  أكمل مهمة واحدة يوميًا للحفاظ على الـ Streak وزيادة تقدمك الدراسي
                </p>

                <div className="mt-3 flex gap-3">
                  <div className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5" style={{ background: 'rgba(251,191,36,0.1)' }}>
                    <Flame size={12} className="text-amber-400" />
                    <span className="text-[11px] font-medium text-amber-400">مهمة = Streak</span>
                  </div>
                  <div className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5" style={{ background: 'rgba(0,198,255,0.1)' }}>
                    <Zap size={12} className="text-cyan-400" />
                    <span className="text-[11px] font-medium text-cyan-400">مهمة = +10 XP</span>
                  </div>
                </div>
              </div>
            </div>

            <motion.button
              whileTap={{ scale: 0.97 }}
              onClick={handleDismiss}
              className="mt-4 w-full rounded-xl py-2.5 text-sm font-semibold text-white"
              style={{
                background: 'linear-gradient(135deg, rgba(251,191,36,0.25) 0%, rgba(245,158,11,0.15) 100%)',
                border: '1px solid rgba(251,191,36,0.3)',
              }}
            >
              فهمت! ابدأ الدراسة 🚀
            </motion.button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
