import { motion } from 'framer-motion';
import { Home, BookOpen, GraduationCap, MessageCircle, User } from 'lucide-react';
import { useAppStore, Page } from '../../store/useAppStore';

const TABS: { id: Page; icon: typeof Home; label: string }[] = [
  { id: 'home',      icon: Home,           label: 'الرئيسية' },
  { id: 'flashcards', icon: BookOpen,      label: 'البطاقات' },
  { id: 'exams',     icon: GraduationCap,  label: 'الامتحانات' },
  { id: 'chat',      icon: MessageCircle,  label: 'المساعد' },
  { id: 'profile',   icon: User,           label: 'الملف' },
];

export default function BottomNav() {
  const { currentPage, setPage } = useAppStore();

  const showNav = !['splash'].includes(currentPage);
  if (!showNav) return null;

  return (
    <motion.nav
      initial={{ y: 100 }}
      animate={{ y: 0 }}
      transition={{ type: 'spring', stiffness: 260, damping: 28, delay: 0.2 }}
      className="fixed bottom-0 left-0 right-0 z-50"
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
    >
      <div
        className="mx-3 mb-3 rounded-3xl px-2 py-2"
        style={{
          background: 'rgba(10, 15, 30, 0.92)',
          backdropFilter: 'blur(24px)',
          WebkitBackdropFilter: 'blur(24px)',
          border: '1px solid rgba(255,255,255,0.08)',
          boxShadow: '0 -4px 30px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.04)',
        }}
      >
        <div className="flex items-center justify-around">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            const isActive = currentPage === tab.id ||
              (tab.id === 'exams' && ['exam-solver', 'exam-results'].includes(currentPage));

            return (
              <motion.button
                key={tab.id}
                whileTap={{ scale: 0.88 }}
                onClick={() => setPage(tab.id)}
                className="relative flex flex-col items-center justify-center py-2 px-3 min-w-[52px] rounded-2xl transition-colors duration-200"
              >
                {isActive && (
                  <motion.div
                    layoutId="nav-indicator"
                    className="absolute inset-0 rounded-2xl"
                    style={{
                      background: 'linear-gradient(135deg, rgba(0,198,255,0.12) 0%, rgba(0,144,255,0.08) 100%)',
                      border: '1px solid rgba(0,198,255,0.2)',
                    }}
                    transition={{ type: 'spring', stiffness: 300, damping: 30 }}
                  />
                )}

                <motion.div
                  animate={{
                    scale: isActive ? 1.1 : 1,
                    color: isActive ? '#00c6ff' : 'rgba(148,163,184,0.7)',
                  }}
                  transition={{ duration: 0.2 }}
                  className="relative z-10"
                >
                  <Icon size={20} strokeWidth={isActive ? 2.5 : 1.8} />
                </motion.div>

                <motion.span
                  animate={{
                    opacity: isActive ? 1 : 0.5,
                    color: isActive ? '#00c6ff' : '#94a3b8',
                  }}
                  className="relative z-10 mt-0.5 text-[10px] font-medium tracking-wide"
                >
                  {tab.label}
                </motion.span>

                {isActive && (
                  <motion.div
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    className="absolute -top-1 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full"
                    style={{ background: '#00c6ff', boxShadow: '0 0 6px #00c6ff' }}
                  />
                )}
              </motion.button>
            );
          })}
        </div>
      </div>
    </motion.nav>
  );
}
