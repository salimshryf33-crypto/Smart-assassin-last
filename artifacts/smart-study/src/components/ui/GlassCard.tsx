import { motion } from 'framer-motion';
import { ReactNode } from 'react';

interface GlassCardProps {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
  hover?: boolean;
  neon?: boolean;
  delay?: number;
}

export default function GlassCard({ children, className = '', onClick, hover = true, neon = false, delay = 0 }: GlassCardProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay, ease: [0.25, 0.46, 0.45, 0.94] }}
      whileHover={hover ? { y: -2, transition: { duration: 0.2 } } : undefined}
      whileTap={onClick ? { scale: 0.98 } : undefined}
      onClick={onClick}
      className={`
        glass-card rounded-2xl
        ${neon ? 'neon-border' : ''}
        ${hover ? 'card-hover' : ''}
        ${onClick ? 'cursor-pointer' : ''}
        ${className}
      `}
    >
      {children}
    </motion.div>
  );
}
