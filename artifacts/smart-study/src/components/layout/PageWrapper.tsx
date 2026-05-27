import { motion } from 'framer-motion';
import { ReactNode } from 'react';

interface PageWrapperProps {
  children: ReactNode;
  className?: string;
}

const variants = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -8 },
};

export default function PageWrapper({ children, className = '' }: PageWrapperProps) {
  return (
    <motion.div
      variants={variants}
      initial="initial"
      animate="animate"
      exit="exit"
      transition={{ duration: 0.3, ease: [0.25, 0.46, 0.45, 0.94] }}
      className={`min-h-screen pb-28 ${className}`}
      style={{ backgroundColor: '#0a0f1e' }}
    >
      {children}
    </motion.div>
  );
}
