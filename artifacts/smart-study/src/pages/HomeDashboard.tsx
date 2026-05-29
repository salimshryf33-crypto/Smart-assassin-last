import { motion } from 'framer-motion';
import { Flame, CheckCircle2, Circle, BookOpen, Timer, Zap, TrendingUp, Plus, Settings, ChevronRight } from 'lucide-react';
import { useAppStore, Task } from '../store/useAppStore';
import { useAuth } from '../contexts/AuthContext';
import { saveTask, updateTaskFS } from '../lib/firestore';
import PageWrapper from '../components/layout/PageWrapper';
import GlassCard from '../components/ui/GlassCard';
import EmptyState from '../components/ui/EmptyState';
import { truncate } from '../utils/format';

function StreakCard() {
  const streak = useAppStore((s) => s.userProfile.streak);
  const totalSessions = useAppStore((s) => s.userProfile.totalSessions);
  const name = useAppStore((s) => s.userProfile.name);

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
          <p className="text-sm text-slate-400">Good morning,</p>
          <h2 className="text-2xl font-bold text-white">{name || 'Student'} 👋</h2>
          <p className="mt-1 text-xs text-slate-400">Keep the momentum going!</p>
        </div>
        <div className="flex flex-col items-center">
          <motion.div
            animate={{ scale: [1, 1.1, 1] }}
            transition={{ duration: 2, repeat: Infinity }}
            className="flex h-14 w-14 items-center justify-center rounded-2xl"
            style={{
              background: 'linear-gradient(135deg, rgba(251,191,36,0.2) 0%, rgba(245,158,11,0.1) 100%)',
              border: '1px solid rgba(251,191,36,0.3)',
            }}
          >
            <Flame size={26} className="text-amber-400" />
          </motion.div>
          <span className="mt-1 text-xl font-bold text-amber-400">{streak}</span>
          <span className="text-[10px] text-amber-400/70">day streak</span>
        </div>
      </div>

      <div className="mt-5 flex gap-4">
        <div className="flex-1 rounded-2xl p-3" style={{ background: 'rgba(0,0,0,0.2)' }}>
          <p className="text-lg font-bold text-white">{totalSessions}</p>
          <p className="text-[11px] text-slate-400">Sessions</p>
        </div>
        <div className="flex-1 rounded-2xl p-3" style={{ background: 'rgba(0,0,0,0.2)' }}>
          <p className="text-lg font-bold text-[#00c6ff]">85%</p>
          <p className="text-[11px] text-slate-400">Accuracy</p>
        </div>
        <div className="flex-1 rounded-2xl p-3" style={{ background: 'rgba(0,0,0,0.2)' }}>
          <p className="text-lg font-bold text-emerald-400">12h</p>
          <p className="text-[11px] text-slate-400">This week</p>
        </div>
      </div>
    </motion.div>
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

function TaskItem({ task, uid }: { task: Task; uid: string | undefined }) {
  const toggleTask = useAppStore((s) => s.toggleTask);
  const priorityColor = task.priority === 'high' ? '#f87171' : task.priority === 'medium' ? '#f59e0b' : '#34d399';

  const handleToggle = () => {
    toggleTask(task.id);
    const updatedTask = { ...task, completed: !task.completed };
    if (uid) {
      updateTaskFS(uid, updatedTask).catch((err) =>
        console.error('[Firestore] Failed to toggle task:', err)
      );
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
              description="Your AI study journey begins here. Add tasks to track your progress."
              cta="Add your first task"
              onCta={handleAddTask}
            />
          ) : (
            <GlassCard className="overflow-hidden" delay={0.25}>
              <div className="divide-y divide-white/[0.04]">
                {todayTasks.map((task) => (
                  <TaskItem key={task.id} task={task} uid={user?.uid} />
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
    </PageWrapper>
  );
}
