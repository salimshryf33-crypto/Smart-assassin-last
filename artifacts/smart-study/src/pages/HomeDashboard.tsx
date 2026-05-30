import { useEffect } from 'react';
import { motion } from 'framer-motion';
import { Flame, CheckCircle2, Circle, BookOpen, Timer, Zap, TrendingUp, Plus, Settings, ChevronRight, Trophy, Brain, MessageSquare } from 'lucide-react';
import { useAppStore, Task } from '../store/useAppStore';
import { useAuth } from '../contexts/AuthContext';
import { useStreak } from '../hooks/useStreak';
import { saveTask, updateTaskFS } from '../lib/firestore';
import StreakTooltip from '../components/StreakTooltip';
import PageWrapper from '../components/layout/PageWrapper';
import GlassCard from '../components/ui/GlassCard';
import EmptyState from '../components/ui/EmptyState';
import { truncate } from '../utils/format';

function StreakCard() {
  const gamification = useAppStore((s) => s.gamification);
  const name = useAppStore((s) => s.userProfile.name);
  const { checkAndResetStreak } = useStreak();

  useEffect(() => {
    checkAndResetStreak();
  }, []);

  // Single source of truth: gamification (synced from Firestore)
  const { currentStreak, longestStreak, xp } = gamification;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="relative overflow-hidden rounded-3xl p-6"
      style={{
        background: 'linear-gradient(135deg, rgba(0,144,255,0.2) 0%, rgba(0,198,255,0.1) 50%, rgba(0,80,160,0.15) 100%)',
        border: '1px solid rgba(0,198,255,0.25)',
        boxShadow: '0 8px 32px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.08)',
      }}
    >
      <div
        className="absolute right-0 top-0 h-32 w-32 opacity-20"
        style={{ background: 'radial-gradient(circle, rgba(0,198,255,0.8) 0%, transparent 70%)' }}
      />

      <div className="relative z-10 flex items-start justify-between">
        <div>
          <p className="text-sm text-slate-400">مرحبًا،</p>
          <h2 className="text-2xl font-bold text-white">{name || 'Student'} 👋</h2>
          <p className="mt-1 text-xs text-slate-400">أكمل المهام الثلاث لتحصل على يوم streak!</p>
        </div>
        <div className="flex flex-col items-center">
          <motion.div
            animate={{ scale: currentStreak > 0 ? [1, 1.1, 1] : 1 }}
            transition={{ duration: 2, repeat: Infinity }}
            className="flex h-14 w-14 items-center justify-center rounded-2xl"
            style={{
              background: currentStreak > 0
                ? 'linear-gradient(135deg, rgba(251,191,36,0.25) 0%, rgba(245,158,11,0.15) 100%)'
                : 'rgba(255,255,255,0.05)',
              border: currentStreak > 0 ? '1px solid rgba(251,191,36,0.4)' : '1px solid rgba(255,255,255,0.08)',
            }}
          >
            <Flame size={26} className={currentStreak > 0 ? 'text-amber-400' : 'text-slate-600'} />
          </motion.div>
          <span className={`mt-1 text-xl font-bold ${currentStreak > 0 ? 'text-amber-400' : 'text-slate-500'}`}>
            {currentStreak}
          </span>
          <span className={`text-[10px] ${currentStreak > 0 ? 'text-amber-400/70' : 'text-slate-600'}`}>
            day streak
          </span>
        </div>
      </div>

      <div className="mt-5 flex gap-4">
        <div className="flex-1 rounded-2xl p-3" style={{ background: 'rgba(0,0,0,0.2)' }}>
          <div className="flex items-center gap-1.5">
            <Zap size={12} className="text-cyan-400" />
            <p className="text-lg font-bold text-white">{xp ?? 0}</p>
          </div>
          <p className="text-[11px] text-slate-400">XP</p>
        </div>
        <div className="flex-1 rounded-2xl p-3" style={{ background: 'rgba(0,0,0,0.2)' }}>
          <div className="flex items-center gap-1.5">
            <Trophy size={12} className="text-amber-400" />
            <p className="text-lg font-bold text-amber-300">{longestStreak ?? 0}</p>
          </div>
          <p className="text-[11px] text-slate-400">Best</p>
        </div>
        <div className="flex-1 rounded-2xl p-3" style={{ background: 'rgba(0,0,0,0.2)' }}>
          <p className="text-lg font-bold text-emerald-400">
            {currentStreak > 0 ? '🔥' : '💤'}
          </p>
          <p className="text-[11px] text-slate-400">
            {currentStreak > 0 ? 'Active' : 'Start!'}
          </p>
        </div>
      </div>
    </motion.div>
  );
}

function DailyChecklistCard() {
  const checklist = useAppStore((s) => s.dailyChecklist);
  const setPage = useAppStore((s) => s.setPage);

  const items = [
    {
      key: 'taskDone' as const,
      label: 'أكمل مهمة',
      sublabel: 'من قائمة المهام',
      icon: CheckCircle2,
      color: '#34d399',
      done: checklist.taskDone,
      navigates: false,
      action: undefined as (() => void) | undefined,
    },
    {
      key: 'aiChatDone' as const,
      label: 'AI Chat',
      sublabel: 'رسالة دراسية حقيقية',
      icon: Brain,
      color: '#00c6ff',
      done: checklist.aiChatDone,
      navigates: true,
      action: () => setPage('chat'),
    },
    {
      key: 'cardReviewed' as const,
      label: 'مراجعة بطاقة',
      sublabel: 'اقلب وصنّف بطاقة',
      icon: BookOpen,
      color: '#f59e0b',
      done: checklist.cardReviewed,
      navigates: true,
      action: () => setPage('flashcards'),
    },
  ];

  const doneCount = items.filter((i) => i.done).length;
  const allDone = checklist.dailyCompleted;

  return (
    <GlassCard className="p-4" delay={0.1}>
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-white">Daily Streak Conditions</h3>
          <p className="text-[11px] text-slate-500 mt-0.5">أكمل الثلاثة لتحصل على يوم streak</p>
        </div>
        <div className="flex items-center gap-1.5">
          {allDone ? (
            <span className="text-[11px] font-bold text-amber-400">🔥 Streak earned!</span>
          ) : (
            <span className="text-xs text-slate-500">{doneCount}/3</span>
          )}
        </div>
      </div>

      {/* Progress bar */}
      <div className="mb-3 h-1.5 w-full overflow-hidden rounded-full" style={{ background: 'rgba(255,255,255,0.06)' }}>
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${(doneCount / 3) * 100}%` }}
          transition={{ duration: 0.6, ease: 'easeOut' }}
          className="h-full rounded-full"
          style={{
            background: allDone
              ? 'linear-gradient(90deg, #f59e0b, #fbbf24)'
              : 'linear-gradient(90deg, #00c6ff, #38bdf8)',
          }}
        />
      </div>

      <div className="space-y-2">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <motion.div
              key={item.key}
              whileTap={!item.done ? { scale: 0.98 } : {}}
              onClick={!item.done && item.navigates ? item.action : undefined}
              className={`flex items-center gap-3 rounded-xl px-3 py-2.5 transition-all ${!item.done && item.navigates ? 'cursor-pointer' : ''}`}
              style={{
                background: item.done ? 'rgba(52,211,153,0.05)' : 'rgba(255,255,255,0.025)',
                border: item.done
                  ? '1px solid rgba(52,211,153,0.15)'
                  : '1px solid rgba(255,255,255,0.05)',
              }}
            >
              <div
                className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl"
                style={{
                  background: item.done ? `${item.color}18` : 'rgba(255,255,255,0.04)',
                  border: `1px solid ${item.done ? item.color + '30' : 'rgba(255,255,255,0.07)'}`,
                }}
              >
                <Icon size={15} style={{ color: item.done ? item.color : '#475569' }} strokeWidth={1.8} />
              </div>
              <div className="flex-1 min-w-0">
                <p className={`text-xs font-medium ${item.done ? 'text-slate-300' : 'text-slate-400'}`}>
                  {item.label}
                </p>
                <p className="text-[10px] text-slate-600">{item.sublabel}</p>
              </div>
              {item.done ? (
                <CheckCircle2 size={16} className="flex-shrink-0 text-emerald-400" />
              ) : (
                <Circle size={16} className="flex-shrink-0 text-slate-700" />
              )}
            </motion.div>
          );
        })}
      </div>
    </GlassCard>
  );
}

function QuickActions() {
  const setPage = useAppStore((s) => s.setPage);

  const actions = [
    { icon: BookOpen, label: 'Flashcards', page: 'flashcards' as const, color: '#00c6ff', bg: 'rgba(0,198,255,0.1)' },
    { icon: Timer, label: 'Focus', page: 'focus' as const, color: '#34d399', bg: 'rgba(52,211,153,0.1)' },
    { icon: Zap, label: 'AI Chat', page: 'chat' as const, color: '#f59e0b', bg: 'rgba(245,158,11,0.1)' },
    { icon: TrendingUp, label: 'Progress', page: 'profile' as const, color: '#f87171', bg: 'rgba(248,113,113,0.1)' },
  ];

  return (
    <div className="grid grid-cols-4 gap-3">
      {actions.map((action, i) => {
        const Icon = action.icon;
        return (
          <motion.button
            key={action.label}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 * i + 0.3 }}
            whileTap={{ scale: 0.92 }}
            whileHover={{ y: -2 }}
            onClick={() => setPage(action.page)}
            className="flex flex-col items-center gap-2 rounded-2xl p-3 transition-all duration-200"
            style={{ background: action.bg, border: `1px solid ${action.color}20` }}
          >
            <Icon size={22} style={{ color: action.color }} strokeWidth={1.8} />
            <span className="text-[11px] font-medium text-slate-300">{action.label}</span>
          </motion.button>
        );
      })}
    </div>
  );
}

function TaskItem({
  task,
  uid,
  onComplete,
}: {
  task: Task;
  uid: string | undefined;
  onComplete: (taskId: string) => void;
}) {
  const toggleTask = useAppStore((s) => s.toggleTask);
  const priorityColor = task.priority === 'high' ? '#f87171' : task.priority === 'medium' ? '#f59e0b' : '#34d399';

  const handleToggle = () => {
    const wasCompleted = task.completed;
    toggleTask(task.id);
    const updatedTask = { ...task, completed: !wasCompleted };
    if (uid) {
      updateTaskFS(uid, updatedTask).catch((err) =>
        console.error('[Firestore] Failed to toggle task:', err)
      );
    }
    if (!wasCompleted) {
      onComplete(task.id);
    }
  };

  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0 }}
      whileTap={{ scale: 0.99 }}
      className="flex items-center gap-3 rounded-xl p-3 transition-all duration-200"
      style={{ background: task.completed ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.03)' }}
      onClick={handleToggle}
    >
      <motion.div whileTap={{ scale: 0.8 }}>
        {task.completed ? (
          <CheckCircle2 size={20} className="text-emerald-400 flex-shrink-0" />
        ) : (
          <Circle size={20} className="text-slate-600 flex-shrink-0" />
        )}
      </motion.div>
      <span className={`flex-1 text-sm ${task.completed ? 'text-slate-500 line-through' : 'text-slate-200'}`}>
        {truncate(task.title, 42)}
      </span>
      <div
        className="h-1.5 w-1.5 flex-shrink-0 rounded-full"
        style={{ background: priorityColor, boxShadow: `0 0 6px ${priorityColor}` }}
      />
    </motion.div>
  );
}

export default function HomeDashboard() {
  const tasks = useAppStore((s) => s.tasks);
  const flashcards = useAppStore((s) => s.flashcards);
  const setPage = useAppStore((s) => s.setPage);
  const addTask = useAppStore((s) => s.addTask);
  const { user } = useAuth();
  const { recordActivity } = useStreak();

  const todayTasks = tasks.slice(0, 5);
  const completedCount = tasks.filter((t) => t.completed).length;
  const progressPct = tasks.length > 0 ? (completedCount / tasks.length) * 100 : 0;

  const handleAddTask = () => {
    const title = prompt('New task:');
    if (!title?.trim()) return;
    const newTask = addTask({ title: title.trim(), completed: false, priority: 'medium' });
    if (user?.uid) {
      saveTask(user.uid, newTask).catch((err) =>
        console.error('[Firestore] Failed to save task:', err)
      );
    }
  };

  const handleTaskComplete = (taskId: string) => {
    recordActivity('task', { taskId }).catch(() => {});
  };

  return (
    <PageWrapper>
      <div className="flex items-center justify-between px-5 pt-14 pb-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-widest text-slate-500">Dashboard</p>
        </div>
        <motion.button
          whileTap={{ scale: 0.9 }}
          onClick={() => setPage('settings')}
          className="flex h-9 w-9 items-center justify-center rounded-xl"
          style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)' }}
        >
          <Settings size={16} className="text-slate-400" />
        </motion.button>
      </div>

      <div className="space-y-5 px-5 pb-32">
        <StreakCard />

        {/* Daily Conditions Checklist */}
        <DailyChecklistCard />

        <div>
          <h3 className="mb-3 text-sm font-semibold text-slate-400 uppercase tracking-wider">Quick Start</h3>
          <QuickActions />
        </div>

        {tasks.length > 0 && (
          <GlassCard className="p-4" delay={0.2}>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-white">Today's Progress</h3>
              <span className="text-xs text-slate-400">{completedCount}/{tasks.length} tasks</span>
            </div>
            <div className="relative h-2 w-full overflow-hidden rounded-full" style={{ background: 'rgba(255,255,255,0.06)' }}>
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${progressPct}%` }}
                transition={{ duration: 1, delay: 0.5, ease: 'easeOut' }}
                className="absolute left-0 top-0 h-full rounded-full"
                style={{ background: 'linear-gradient(90deg, #00c6ff, #38bdf8)' }}
              />
            </div>
          </GlassCard>
        )}

        <div>
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-wider">Today's Tasks</h3>
            <motion.button
              whileTap={{ scale: 0.9 }}
              onClick={handleAddTask}
              className="flex items-center gap-1 text-xs text-[#00c6ff]"
            >
              <Plus size={14} />
              Add
            </motion.button>
          </div>

          {todayTasks.length === 0 ? (
            <EmptyState
              icon={<CheckCircle2 size={32} />}
              title="All clear!"
              description="أضف مهمة وابدأ رحلتك الدراسية اليومية لبناء الـ Streak."
              cta="Add your first task"
              onCta={handleAddTask}
            />
          ) : (
            <GlassCard className="overflow-hidden" delay={0.25}>
              <div className="divide-y divide-white/[0.04]">
                {todayTasks.map((task) => (
                  <TaskItem
                    key={task.id}
                    task={task}
                    uid={user?.uid}
                    onComplete={handleTaskComplete}
                  />
                ))}
              </div>
            </GlassCard>
          )}
        </div>

        <div>
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-wider">Flashcards</h3>
            <motion.button
              whileTap={{ scale: 0.9 }}
              onClick={() => setPage('flashcards')}
              className="flex items-center gap-1 text-xs text-[#00c6ff]"
            >
              View all <ChevronRight size={12} />
            </motion.button>
          </div>

          {flashcards.length === 0 ? (
            <EmptyState
              icon={<BookOpen size={32} />}
              title="Start building your knowledge system"
              description="Create flashcards to power your spaced repetition learning."
              cta="Create first card"
              onCta={() => setPage('flashcards')}
            />
          ) : (
            <GlassCard
              className="p-4"
              delay={0.3}
              onClick={() => setPage('flashcards')}
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-2xl font-bold text-white">{flashcards.length}</p>
                  <p className="text-xs text-slate-400">cards ready to review</p>
                </div>
                <div className="flex -space-x-2">
                  {Array.from(new Set(flashcards.map((c) => c.category))).slice(0, 3).map((cat, i) => (
                    <div
                      key={cat}
                      className="flex h-8 w-8 items-center justify-center rounded-full text-[9px] font-bold text-white"
                      style={{
                        background: [`rgba(0,198,255,0.3)`, `rgba(52,211,153,0.3)`, `rgba(245,158,11,0.3)`][i],
                        border: '2px solid rgba(10,15,30,0.8)',
                        zIndex: 3 - i,
                      }}
                    >
                      {cat[0]}
                    </div>
                  ))}
                </div>
              </div>
              <div className="mt-3 flex items-center gap-2">
                <div className="h-1 flex-1 rounded-full" style={{ background: 'rgba(0,198,255,0.3)' }} />
                <span className="text-[11px] text-slate-400">Tap to study</span>
              </div>
            </GlassCard>
          )}
        </div>
      </div>

      <StreakTooltip />
    </PageWrapper>
  );
}
