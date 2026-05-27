import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Brain, Mail, Lock, User, Eye, EyeOff, AlertCircle } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';

type Mode = 'signin' | 'signup';

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
    </svg>
  );
}

export default function LoginScreen() {
  const { signInWithGoogle, signInWithEmail, signUpWithEmail } = useAuth();
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const clearError = () => setError('');

  const handleGoogleSignIn = async () => {
    setLoading(true);
    clearError();
    try {
      await signInWithGoogle();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('popup-closed')) setError('فشل تسجيل الدخول بـ Google. حاول مجدداً.');
    } finally {
      setLoading(false);
    }
  };

  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) return;
    if (mode === 'signup' && !name) return;
    setLoading(true);
    clearError();
    try {
      if (mode === 'signin') {
        await signInWithEmail(email, password);
      } else {
        await signUpWithEmail(email, password, name);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('user-not-found') || msg.includes('wrong-password') || msg.includes('invalid-credential')) {
        setError('البريد الإلكتروني أو كلمة المرور غير صحيحة.');
      } else if (msg.includes('email-already-in-use')) {
        setError('هذا البريد مستخدم بالفعل. سجّل الدخول.');
      } else if (msg.includes('weak-password')) {
        setError('كلمة المرور ضعيفة — استخدم 6 أحرف على الأقل.');
      } else {
        setError('حدث خطأ. حاول مجدداً.');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden px-6"
      style={{ background: 'linear-gradient(135deg, #060b18 0%, #0a1628 50%, #060b18 100%)' }}
    >
      {/* Background glow */}
      <div
        className="pointer-events-none absolute left-1/2 top-1/3 -translate-x-1/2 -translate-y-1/2 rounded-full"
        style={{ width: '500px', height: '500px', background: 'radial-gradient(circle, rgba(0,198,255,0.06) 0%, transparent 70%)' }}
      />

      <div className="relative z-10 w-full max-w-sm">
        {/* Logo */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-8 flex flex-col items-center gap-3"
        >
          <div
            className="flex h-16 w-16 items-center justify-center rounded-3xl"
            style={{
              background: 'linear-gradient(135deg, rgba(0,198,255,0.15) 0%, rgba(0,144,255,0.1) 100%)',
              border: '1px solid rgba(0,198,255,0.3)',
              boxShadow: '0 0 30px rgba(0,198,255,0.15)',
            }}
          >
            <Brain size={32} className="text-[#00c6ff]" strokeWidth={1.5} />
          </div>
          <div className="text-center">
            <h1
              className="text-2xl font-bold"
              style={{
                background: 'linear-gradient(135deg, #ffffff 0%, #00c6ff 60%)',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                backgroundClip: 'text',
              }}
            >
              Sage
            </h1>
            <p className="mt-1 text-xs text-slate-500">مساعدك الدراسي الذكي</p>
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 28 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="flex flex-col gap-4"
        >
          {/* Mode tabs */}
          <div
            className="flex rounded-2xl p-1"
            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}
          >
            {(['signin', 'signup'] as Mode[]).map((m) => (
              <button
                key={m}
                onClick={() => { setMode(m); clearError(); }}
                className="flex-1 rounded-xl py-2 text-xs font-semibold transition-all"
                style={
                  mode === m
                    ? { background: 'rgba(0,144,255,0.2)', color: '#00c6ff', border: '1px solid rgba(0,198,255,0.25)' }
                    : { color: '#64748b' }
                }
              >
                {m === 'signin' ? 'تسجيل الدخول' : 'إنشاء حساب'}
              </button>
            ))}
          </div>

          {/* Google button */}
          <motion.button
            whileTap={{ scale: 0.97 }}
            onClick={handleGoogleSignIn}
            disabled={loading}
            className="flex w-full items-center justify-center gap-3 rounded-2xl py-3.5 text-sm font-semibold text-white transition-all"
            style={{
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid rgba(255,255,255,0.12)',
            }}
          >
            <GoogleIcon />
            متابعة مع Google
          </motion.button>

          {/* Divider */}
          <div className="flex items-center gap-3">
            <div className="flex-1 border-t border-white/[0.06]" />
            <span className="text-[10px] text-slate-600 uppercase tracking-widest">أو</span>
            <div className="flex-1 border-t border-white/[0.06]" />
          </div>

          {/* Email form */}
          <form onSubmit={handleEmailSubmit} className="flex flex-col gap-3">
            <AnimatePresence>
              {mode === 'signup' && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="overflow-hidden"
                >
                  <div className="relative">
                    <User size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-600" />
                    <input
                      type="text"
                      placeholder="الاسم الكامل"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      className="w-full rounded-2xl py-3.5 pl-10 pr-4 text-sm text-white placeholder-slate-600 outline-none transition-all"
                      style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}
                      dir="rtl"
                    />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            <div className="relative">
              <Mail size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-600" />
              <input
                type="email"
                placeholder="البريد الإلكتروني"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-2xl py-3.5 pl-10 pr-4 text-sm text-white placeholder-slate-600 outline-none"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}
                dir="rtl"
              />
            </div>

            <div className="relative">
              <Lock size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-600" />
              <input
                type={showPassword ? 'text' : 'password'}
                placeholder="كلمة المرور"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-2xl py-3.5 pl-10 pr-12 text-sm text-white placeholder-slate-600 outline-none"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}
                dir="rtl"
              />
              <button
                type="button"
                onClick={() => setShowPassword((p) => !p)}
                className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-600"
              >
                {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>

            {/* Error */}
            <AnimatePresence>
              {error && (
                <motion.div
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="flex items-center gap-2 rounded-xl px-3 py-2.5 text-xs"
                  style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)', color: '#f87171' }}
                >
                  <AlertCircle size={13} />
                  {error}
                </motion.div>
              )}
            </AnimatePresence>

            <motion.button
              whileTap={{ scale: 0.97 }}
              type="submit"
              disabled={loading}
              className="w-full rounded-2xl py-4 text-sm font-bold text-white transition-all"
              style={{
                background: loading
                  ? 'rgba(255,255,255,0.05)'
                  : 'linear-gradient(135deg, #0090ff 0%, #0070c0 100%)',
                boxShadow: loading ? 'none' : '0 8px 24px rgba(0,144,255,0.3)',
              }}
            >
              {loading ? '...' : mode === 'signin' ? 'دخول' : 'إنشاء الحساب'}
            </motion.button>
          </form>

          <p className="text-center text-[10px] text-slate-600 leading-relaxed px-4">
            بالدخول توافق على استخدام التطبيق لأغراض تعليمية. بياناتك خاصة ومحمية.
          </p>
        </motion.div>
      </div>
    </div>
  );
}
