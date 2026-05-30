import { useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Play, Pause, RotateCcw, Coffee, Brain, Trophy } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { useStreak } from '../hooks/useStreak';
import PageWrapper from '../components/layout/PageWrapper';
import { formatTime } from '../utils/format';

const WORK_DURATION = 25 * 60;
const BREAK_DURATION = 5 * 60;
const RADIUS = 110;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function CircularProgress({ progress, mode }: { progress: number; mode: 'work' | 'break' }) {
  const offset = CIRCUMFERENCE * (1 - progress);
  const isWork = mode === 'work';

  return (
    <svg width="280" height="280" className="absolute inset-0">
      <circle
        cx="140" cy="140" r={RADIUS}
        fill="none"
        stroke="rgba(255,255,255,0.05)"
        strokeWidth="8"
      />
      <motion.circle
        cx="140" cy="140" r={RADIUS}
        fill="none"
        stroke={isWork ? 'rgba(0,198,255,0.15)' : 'rgba(52,211,153,0.15)'}
        strokeWidth="12"
        filter="url(#glow)"
      />
      <motion.circle
        cx="140" cy="140" r={RADIUS}
        fill="none"
        stroke={isWork ? 'url(#blueGradient)' : 'url(#greenGradient)'}
        strokeWidth="8"
        strokeLinecap="round"
        strokeDasharray={CIRCUMFERENCE}
        strokeDashoffset={offset}
        style={{ rotate: '-90deg', transformOrigin: 'center', transform: 'rotate(-90deg)' }}
        transition={{ duration: 1, ease: 'linear' }}
      />
      <defs>
        <linearGradient id="blueGradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#00c6ff" />
          <stop offset="100%" stopColor="#38bdf8" />
        </linearGradient>
        <linearGradient id="greenGradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#34d399" />
          <stop offset="100%" stopColor="#10b981" />
        </linearGradient>
        <filter id="glow">
          <feGaussianBlur stdDeviation="4" result="coloredBlur" />
          <feMerge>
            <feMergeNode in="coloredBlur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
    </svg>
  );
}

export default function FocusTimer() {
  const pomodoroState = useAppStore((s) => s.pomodoroState);
  const setPomodoroState = useAppStore((s) => s.setPomodoroState);
  const { recordActivity } = useStreak();
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordActivityRef = useRef(recordActivity);
  useEffect(() => { recordActivityRef.current = recordActivity; }, [recordActivity]);

  const isWork = pomodoroState.mode === 'work';
  const total = isWork ? WORK_DURATION : BREAK_DURATION;
  const progress = 1 - pomodoroState.timeLeft / total;

  useEffect(() => {
    if (pomodoroState.isRunning) {
      intervalRef.current = setInterval(() => {
        const current = useAppStore.getState().pomodoroState;
        const newTime = current.timeLeft - 1;
        if (newTime <= 0) {
          const nextMode = current.mode === 'work' ? 'break' : 'work';
          const isWorkSession = current.mode === 'work';
          const newSessionsCompleted = isWorkSession ? current.sessionsCompleted + 1 : current.sessionsCompleted;

          setPomodoroState({
            timeLeft: nextMode === 'work' ? WORK_DURATION : BREAK_DURATION,
            mode: nextMode,
            isRunning: false,
            sessionsCompleted: newSessionsCompleted,
          });

          if (isWorkSession) {
            console.log('[Gamification] Focus session completed — granting XP + streak');
            recordActivityRef.current('focus_session').catch(() => {});
          }
        } else {
          setPomodoroState({ timeLeft: newTime });
        }
      }, 1000);
    } else {
      if (intervalRef.current) clearInterval(intervalRef.current);
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [pomodoroState.isRunning, setPomodoroState]);

  const toggle = () => setPomodoroState({ isRunning: !pomodoroState.isRunning });
  const reset = () => setPomodoroState({ isRunning: false, timeLeft: isWork ? WORK_DURATION : BREAK_DURATION });
  const switchMode = (mode: 'work' | 'break') =>
    setPomodoroState({ mode, isRunning: false, timeLeft: mode === 'work' ? WORK_DURATION : BREAK_DURATION });

  return (
    <PageWrapper>
      <div className="flex flex-col items-center px-5 pt-14">
        <div className="mb-8 w-full">
          <p className="text-xs font-medium uppercase tracking-widest text-slate-500">Productivity</p>
          <h1 className="text-2xl font-bold text-white">Focus Timer</h1>
        </div>

        <div
          className="mb-10 flex rounded-2xl p-1"
          style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}
        >
          {(['work', 'break'] as const).map((mode) => (
            <motion.button
              key={mode}
              whileTap={{ scale: 0.95 }}
              onClick={() => switchMode(mode)}
              className="relative flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-semibold transition-colors duration-200"
              style={{ color: pomodoroState.mode === mode ? (mode === 'work' ? '#00c6ff' : '#34d399') : '#64748b' }}
            >
              {pomodoroState.mode === mode && (
                <motion.div
                  layoutId="mode-indicator"
                  className="absolute inset-0 rounded-xl"
                  style={{
                    background: mode === 'work'
                      ? 'linear-gradient(135deg, rgba(0,198,255,0.15) 0%, rgba(0,144,255,0.1) 100%)'
                      : 'linear-gradient(135deg, rgba(52,211,153,0.15) 0%, rgba(16,185,129,0.1) 100%)',
                    border: `1px solid ${mode === 'work' ? 'rgba(0,198,255,0.25)' : 'rgba(52,211,153,0.25)'}`,
                  }}
                  transition={{ type: 'spring', stiffness: 300, damping: 30 }}
                />
              )}
              {mode === 'work' ? <Brain size={14} className="relative z-10" /> : <Coffee size={14} className="relative z-10" />}
              <span className="relative z-10 capitalize">{mode === 'work' ? 'Focus' : 'Break'}</span>
            </motion.button>
          ))}
        </div>

        <div className="relative mb-10 flex h-72 w-72 items-center justify-center">
          <motion.div
            className="absolute inset-0 rounded-full"
            animate={{
              boxShadow: pomodoroState.isRunning
                ? isWork
                  ? ['0 0 40px rgba(0,198,255,0.2)', '0 0 80px rgba(0,198,255,0.35)', '0 0 40px rgba(0,198,255,0.2)']
                  : ['0 0 40px rgba(52,211,153,0.2)', '0 0 80px rgba(52,211,153,0.35)', '0 0 40px rgba(52,211,153,0.2)']
                : 'none',
            }}
            transition={{ duration: 2, repeat: pomodoroState.isRunning ? Infinity : 0, ease: 'easeInOut' }}
          />

          <div className="absolute inset-0">
            <CircularProgress progress={progress} mode={pomodoroState.mode} />
          </div>

          <motion.div
            className="relative z-10 flex flex-col items-center gap-1 rounded-full p-8 text-center"
            style={{
              background: 'rgba(10,15,30,0.8)',
              width: '180px',
              height: '180px',
              justifyContent: 'center',
            }}
          >
            <AnimatePresence mode="wait">
              <motion.p
                key={pomodoroState.timeLeft}
                initial={{ scale: 0.9, opacity: 0.7 }}
                animate={{ scale: 1, opacity: 1 }}
                className="text-4xl font-bold tabular-nums"
                style={{ color: isWork ? '#00c6ff' : '#34d399' }}
              >
                {formatTime(pomodoroState.timeLeft)}
              </motion.p>
            </AnimatePresence>
            <p className="text-xs font-medium capitalize text-slate-400">
              {isWork ? 'Deep Focus' : 'Recharge'}
            </p>
          </motion.div>
        </div>

        <div className="mb-8 flex items-center gap-4">
          <motion.button
            whileTap={{ scale: 0.9 }}
            onClick={reset}
            className="flex h-12 w-12 items-center justify-center rounded-2xl"
            style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)' }}
          >
            <RotateCcw size={18} className="text-slate-400" />
          </motion.button>

          <motion.button
            whileTap={{ scale: 0.95 }}
            whileHover={{ scale: 1.02 }}
            onClick={toggle}
            className="flex h-16 w-36 items-center justify-center gap-2 rounded-2xl text-sm font-bold text-white"
            style={{
              background: isWork
                ? 'linear-gradient(135deg, #0090ff, #00c6ff)'
                : 'linear-gradient(135deg, #10b981, #34d399)',
              boxShadow: isWork
                ? '0 6px 24px rgba(0,144,255,0.35)'
                : '0 6px 24px rgba(16,185,129,0.35)',
            }}
          >
            {pomodoroState.isRunning ? (
              <><Pause size={18} /> Pause</>
            ) : (
              <><Play size={18} fill="white" /> Start</>
            )}
          </motion.button>
        </div>

        <div className="w-full">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">Sessions Today</h3>
          <div
            className="flex items-center gap-3 rounded-2xl p-4"
            style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}
          >
            <div
              className="flex h-10 w-10 items-center justify-center rounded-xl"
              style={{ background: 'linear-gradient(135deg, rgba(245,158,11,0.2) 0%, rgba(251,191,36,0.1) 100%)', border: '1px solid rgba(245,158,11,0.3)' }}
            >
              <Trophy size={18} className="text-amber-400" />
            </div>
            <div>
              <p className="text-base font-bold text-white">{pomodoroState.sessionsCompleted} sessions</p>
              <p className="text-xs text-slate-500">completed today · {pomodoroState.sessionsCompleted * 25} min focused</p>
            </div>
          </div>
        </div>

        <div className="mt-5 flex gap-2">
          {Array.from({ length: Math.max(4, pomodoroState.sessionsCompleted + 1) }, (_, i) => (
            <motion.div
              key={i}
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ delay: i * 0.05 }}
              className="h-3 w-3 rounded-full"
              style={{
                background: i < pomodoroState.sessionsCompleted
                  ? 'linear-gradient(135deg, #00c6ff, #38bdf8)'
                  : 'rgba(255,255,255,0.08)',
                boxShadow: i < pomodoroState.sessionsCompleted ? '0 0 8px rgba(0,198,255,0.5)' : 'none',
              }}
            />
          ))}
        </div>
      </div>
    </PageWrapper>
  );
}
