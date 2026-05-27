import { motion } from 'framer-motion';
import { ReactNode } from 'react';

interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  description: string;
  cta?: string;
  onCta?: () => void;
}

export default function EmptyState({ icon, title, description, cta, onCta }: EmptyStateProps) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.5, ease: 'easeOut' }}
      className="flex flex-col items-center justify-center py-16 px-6 text-center"
    >
      <motion.div
        animate={{ y: [0, -8, 0] }}
        transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
        className="mb-6 flex h-24 w-24 items-center justify-center rounded-3xl"
        style={{
          background: 'linear-gradient(135deg, rgba(0,198,255,0.1) 0%, rgba(0,144,255,0.05) 100%)',
          border: '1px solid rgba(0,198,255,0.2)',
          boxShadow: '0 0 30px rgba(0,198,255,0.1)',
        }}
      >
        <div className="text-[#00c6ff] opacity-80">{icon}</div>
      </motion.div>

      <motion.h3
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.15 }}
        className="mb-2 text-lg font-semibold text-white"
      >
        {title}
      </motion.h3>

      <motion.p
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.25 }}
        className="mb-8 max-w-xs text-sm leading-relaxed text-slate-400"
      >
        {description}
      </motion.p>

      {cta && onCta && (
        <motion.button
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.35 }}
          whileHover={{ scale: 1.03, boxShadow: '0 8px 30px rgba(0,144,255,0.4)' }}
          whileTap={{ scale: 0.97 }}
          onClick={onCta}
          className="btn-primary px-8 py-3 text-sm font-semibold"
        >
          {cta}
        </motion.button>
      )}
    </motion.div>
  );
}
