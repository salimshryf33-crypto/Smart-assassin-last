import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, BookOpen, CheckSquare, X, Sparkles } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import PageWrapper from '../components/layout/PageWrapper';

export default function SearchPage() {
  const [query, setQuery] = useState('');
  const { flashcards, tasks, setPage } = useAppStore();

  const q = query.toLowerCase().trim();

  const matchedFlashcards = q
    ? flashcards.filter((c) => c.front.toLowerCase().includes(q) || c.back.toLowerCase().includes(q) || c.category.toLowerCase().includes(q))
    : [];

  const matchedTasks = q
    ? tasks.filter((t) => t.title.toLowerCase().includes(q))
    : [];

  const hasResults = matchedFlashcards.length > 0 || matchedTasks.length > 0;

  return (
    <PageWrapper>
      <div className="px-5 pt-14 pb-32">
        <div className="mb-6">
          <p className="text-xs font-medium uppercase tracking-widest text-slate-500">Discover</p>
          <h1 className="text-2xl font-bold text-white">Search</h1>
        </div>

        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          className="relative mb-6"
        >
          <div
            className="flex items-center gap-3 rounded-2xl px-4 py-3.5"
            style={{
              background: 'rgba(255,255,255,0.04)',
              border: `1px solid ${query ? 'rgba(0,198,255,0.35)' : 'rgba(255,255,255,0.08)'}`,
              boxShadow: query ? '0 0 20px rgba(0,198,255,0.08)' : 'none',
              transition: 'all 0.2s ease',
            }}
          >
            <Search size={18} className="flex-shrink-0 text-slate-500" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search flashcards, tasks..."
              className="flex-1 bg-transparent text-sm text-white placeholder-slate-600 outline-none"
            />
            <AnimatePresence>
              {query && (
                <motion.button
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  exit={{ scale: 0 }}
                  whileTap={{ scale: 0.85 }}
                  onClick={() => setQuery('')}
                  className="flex h-6 w-6 items-center justify-center rounded-full"
                  style={{ background: 'rgba(255,255,255,0.1)' }}
                >
                  <X size={12} className="text-slate-400" />
                </motion.button>
              )}
            </AnimatePresence>
          </div>
        </motion.div>

        <AnimatePresence mode="wait">
          {!query ? (
            <motion.div
              key="empty"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-col items-center justify-center pt-16"
            >
              <motion.div
                animate={{ y: [0, -6, 0] }}
                transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
                className="mb-4 flex h-20 w-20 items-center justify-center rounded-3xl"
                style={{
                  background: 'linear-gradient(135deg, rgba(0,198,255,0.1) 0%, rgba(0,144,255,0.05) 100%)',
                  border: '1px solid rgba(0,198,255,0.2)',
                }}
              >
                <Sparkles size={32} className="text-[#00c6ff] opacity-70" />
              </motion.div>
              <p className="text-base font-semibold text-white">Find anything instantly</p>
              <p className="mt-1 text-center text-sm text-slate-400">
                Search across all your flashcards and tasks
              </p>

              <div className="mt-8 w-full space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-3">Recent categories</p>
                {Array.from(new Set(flashcards.map((c) => c.category))).slice(0, 4).map((cat, i) => (
                  <motion.button
                    key={cat}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: i * 0.07 }}
                    whileTap={{ scale: 0.98 }}
                    onClick={() => setQuery(cat)}
                    className="flex w-full items-center gap-3 rounded-xl p-3"
                    style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)' }}
                  >
                    <div
                      className="flex h-8 w-8 items-center justify-center rounded-xl"
                      style={{ background: 'rgba(0,198,255,0.1)' }}
                    >
                      <BookOpen size={14} className="text-[#00c6ff]" />
                    </div>
                    <span className="text-sm text-slate-300">{cat}</span>
                  </motion.button>
                ))}
              </div>
            </motion.div>
          ) : hasResults ? (
            <motion.div
              key="results"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="space-y-6"
            >
              {matchedFlashcards.length > 0 && (
                <div>
                  <div className="mb-2 flex items-center gap-2">
                    <BookOpen size={14} className="text-[#00c6ff]" />
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                      Flashcards ({matchedFlashcards.length})
                    </h3>
                  </div>
                  <div className="space-y-2">
                    {matchedFlashcards.map((card, i) => (
                      <motion.div
                        key={card.id}
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: i * 0.05 }}
                        whileTap={{ scale: 0.98 }}
                        onClick={() => setPage('flashcards')}
                        className="rounded-2xl p-4 cursor-pointer"
                        style={{
                          background: 'rgba(0,198,255,0.04)',
                          border: '1px solid rgba(0,198,255,0.1)',
                        }}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-sm font-medium text-white leading-snug">{card.front}</p>
                          <span
                            className="flex-shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium"
                            style={{ background: 'rgba(0,198,255,0.1)', color: '#00c6ff' }}
                          >
                            {card.category}
                          </span>
                        </div>
                        <p className="mt-1.5 text-xs text-slate-500 line-clamp-2">{card.back}</p>
                      </motion.div>
                    ))}
                  </div>
                </div>
              )}

              {matchedTasks.length > 0 && (
                <div>
                  <div className="mb-2 flex items-center gap-2">
                    <CheckSquare size={14} className="text-emerald-400" />
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                      Tasks ({matchedTasks.length})
                    </h3>
                  </div>
                  <div className="space-y-2">
                    {matchedTasks.map((task, i) => (
                      <motion.div
                        key={task.id}
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: i * 0.05 }}
                        className="flex items-center gap-3 rounded-2xl p-4"
                        style={{
                          background: 'rgba(52,211,153,0.04)',
                          border: '1px solid rgba(52,211,153,0.1)',
                        }}
                      >
                        <CheckSquare size={16} className={task.completed ? 'text-emerald-400' : 'text-slate-600'} />
                        <span className={`text-sm ${task.completed ? 'text-slate-500 line-through' : 'text-slate-200'}`}>
                          {task.title}
                        </span>
                        <span
                          className="ml-auto flex-shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium capitalize"
                          style={{
                            background: task.priority === 'high' ? 'rgba(248,113,113,0.1)' : task.priority === 'medium' ? 'rgba(245,158,11,0.1)' : 'rgba(52,211,153,0.1)',
                            color: task.priority === 'high' ? '#f87171' : task.priority === 'medium' ? '#f59e0b' : '#34d399',
                          }}
                        >
                          {task.priority}
                        </span>
                      </motion.div>
                    ))}
                  </div>
                </div>
              )}
            </motion.div>
          ) : (
            <motion.div
              key="no-results"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="flex flex-col items-center justify-center pt-16 text-center"
            >
              <div
                className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}
              >
                <Search size={24} className="text-slate-600" />
              </div>
              <p className="text-base font-semibold text-white">No results for "{query}"</p>
              <p className="mt-1 text-sm text-slate-400">Try a different keyword or category</p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </PageWrapper>
  );
}
