import { useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { useAppStore } from '../store/useAppStore';
import { Brain } from 'lucide-react';

function Particle({ x, y, size, delay }: { x: number; y: number; size: number; delay: number }) {
  return (
    <motion.div
      className="absolute rounded-full"
      style={{
        left: `${x}%`,
        top: `${y}%`,
        width: size,
        height: size,
        background: `rgba(0, 198, 255, ${0.1 + Math.random() * 0.3})`,
        boxShadow: `0 0 ${size * 2}px rgba(0, 198, 255, 0.4)`,
      }}
      initial={{ opacity: 0, scale: 0 }}
      animate={{
        opacity: [0, 0.8, 0.4, 0.8, 0],
        scale: [0, 1, 0.8, 1.2, 0],
        y: [-20, 20],
      }}
      transition={{
        duration: 4 + Math.random() * 3,
        delay,
        repeat: Infinity,
        ease: 'easeInOut',
      }}
    />
  );
}

const particles = Array.from({ length: 30 }, (_, i) => ({
  id: i,
  x: Math.random() * 100,
  y: Math.random() * 100,
  size: 2 + Math.random() * 4,
  delay: Math.random() * 3,
}));

export default function SplashScreen() {
  const setPage = useAppStore((s) => s.setPage);
  const profileComplete = useAppStore((s) => s.studentProfile?.profileComplete ?? false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();
  const profileCompleteRef = useRef(profileComplete);
  profileCompleteRef.current = profileComplete;

  useEffect(() => {
    const proceed = () => {
      setPage(profileCompleteRef.current ? 'home' : 'profile-setup');
    };
    timerRef.current = setTimeout(proceed, 3500);
    return () => clearTimeout(timerRef.current);
  }, [setPage]);

  return (
    <div
      className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden"
      style={{ background: 'linear-gradient(135deg, #060b18 0%, #0a1628 50%, #060b18 100%)' }}
      onClick={() => {
        clearTimeout(timerRef.current);
        setPage(profileCompleteRef.current ? 'home' : 'profile-setup');
      }}
    >
      {particles.map((p) => (
        <Particle key={p.id} x={p.x} y={p.y} size={p.size} delay={p.delay} />
      ))}

      <div
        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
        style={{
          width: '600px',
          height: '600px',
          background: 'radial-gradient(circle, rgba(0,198,255,0.06) 0%, transparent 70%)',
        }}
      />

      <div
        className="absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage: 'linear-gradient(rgba(0,198,255,0.5) 1px, transparent 1px), linear-gradient(90deg, rgba(0,198,255,0.5) 1px, transparent 1px)',
          backgroundSize: '40px 40px',
        }}
      />

      <div className="relative z-10 flex flex-col items-center gap-8">
        <motion.div
          initial={{ scale: 0, rotate: -180 }}
          animate={{ scale: 1, rotate: 0 }}
          transition={{ duration: 0.8, ease: [0.34, 1.56, 0.64, 1] }}
          className="relative"
        >
          <motion.div
            animate={{ rotate: 360 }}
            transition={{ duration: 12, repeat: Infinity, ease: 'linear' }}
            className="absolute inset-0 rounded-full"
            style={{
              border: '2px solid transparent',
              borderTopColor: 'rgba(0,198,255,0.6)',
              borderRightColor: 'rgba(0,144,255,0.3)',
            }}
          />
          <motion.div
            animate={{ rotate: -360 }}
            transition={{ duration: 18, repeat: Infinity, ease: 'linear' }}
            className="absolute -inset-3 rounded-full"
            style={{
              border: '1px solid transparent',
              borderTopColor: 'rgba(0,198,255,0.2)',
              borderLeftColor: 'rgba(56,189,248,0.3)',
            }}
          />

          <motion.div
            className="flex h-24 w-24 items-center justify-center rounded-3xl"
            animate={{ boxShadow: ['0 0 30px rgba(0,198,255,0.3)', '0 0 60px rgba(0,198,255,0.6)', '0 0 30px rgba(0,198,255,0.3)'] }}
            transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
            style={{
              background: 'linear-gradient(135deg, rgba(0,198,255,0.15) 0%, rgba(0,144,255,0.1) 100%)',
              border: '1px solid rgba(0,198,255,0.3)',
            }}
          >
            <Brain size={44} className="text-[#00c6ff]" strokeWidth={1.5} />
          </motion.div>
        </motion.div>

        <div className="flex flex-col items-center gap-3">
          <motion.h1
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.5, duration: 0.6 }}
            className="text-4xl font-bold tracking-tight"
            style={{
              background: 'linear-gradient(135deg, #ffffff 0%, #00c6ff 50%, #38bdf8 100%)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              backgroundClip: 'text',
            }}
          >
            Smart Study
          </motion.h1>
          <motion.h1
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.65, duration: 0.6 }}
            className="text-4xl font-bold tracking-tight"
            style={{
              background: 'linear-gradient(135deg, #00c6ff 0%, #38bdf8 100%)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              backgroundClip: 'text',
            }}
          >
            Assistant
          </motion.h1>

          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.9, duration: 0.8 }}
            className="text-center text-sm font-medium tracking-widest text-slate-400 uppercase"
          >
            Your AI-powered study companion
          </motion.p>
        </div>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 1.4 }}
          className="flex gap-2"
        >
          {[0, 1, 2].map((i) => (
            <motion.div
              key={i}
              animate={{ scale: [1, 1.5, 1], opacity: [0.4, 1, 0.4] }}
              transition={{ duration: 1.2, delay: i * 0.2, repeat: Infinity }}
              className="h-1.5 w-1.5 rounded-full bg-[#00c6ff]"
            />
          ))}
        </motion.div>
      </div>

      <motion.p
        initial={{ opacity: 0 }}
        animate={{ opacity: 0.35 }}
        transition={{ delay: 2 }}
        className="absolute bottom-12 text-xs text-slate-400"
      >
        Tap to continue
      </motion.p>
    </div>
  );
}
