import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useAppStore } from './store/useAppStore';
import { useAuth } from './contexts/AuthContext';
import BottomNav from './components/layout/BottomNav';
import SplashScreen from './pages/SplashScreen';
import ProfileSetupScreen from './pages/ProfileSetupScreen';
import LoginScreen from './pages/LoginScreen';
import HomeDashboard from './pages/HomeDashboard';
import FlashcardsPage from './pages/FlashcardsPage';
import FocusTimer from './pages/FocusTimer';
import AIChat from './pages/AIChat';
import SearchPage from './pages/SearchPage';
import ProfilePage from './pages/ProfilePage';
import SettingsPage from './pages/SettingsPage';
import CurriculumManager from './pages/CurriculumManager';
import { Brain, MailWarning, X } from 'lucide-react';

const NO_NAV_PAGES = new Set(['splash', 'profile-setup', 'login', 'curriculum-manager']);

// ─── Loading Screen ───────────────────────────────────────────────────────────

function LoadingScreen() {
  return (
    <div
      className="flex min-h-screen items-center justify-center"
      style={{ background: 'linear-gradient(135deg, #060b18 0%, #0a1628 100%)' }}
    >
      <div className="flex flex-col items-center gap-4">
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
        <div className="flex gap-1.5">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-1.5 w-1.5 rounded-full bg-[#00c6ff] animate-pulse"
              style={{ animationDelay: `${i * 0.2}s` }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Email Verification Banner ────────────────────────────────────────────────
//
// Shown only to email/password users whose address is not yet verified.
// Google Sign-In users are always verified and never see this banner.
// The app remains fully functional — verification is encouraged, not enforced.
//
// ─────────────────────────────────────────────────────────────────────────────

function EmailVerificationBanner() {
  const { user, emailVerified, resendVerificationEmail, reloadUser } = useAuth();
  const [dismissed, setDismissed] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [sendError, setSendError] = useState('');
  const [reloading, setReloading] = useState(false);

  const isEmailUser = user?.providerData[0]?.providerId === 'password';
  // Use context-managed emailVerified so reloadUser() triggers a re-render
  if (!user || !isEmailUser || emailVerified || dismissed) return null;

  const handleResend = async () => {
    if (sending || sent) return;
    setSending(true);
    setSendError('');
    try {
      await resendVerificationEmail();
      setSent(true);
    } catch {
      setSendError('فشل الإرسال');
    } finally {
      setSending(false);
    }
  };

  // Called after the user clicks the link in their inbox and returns to the app.
  // Calls auth.currentUser.reload() on the server and syncs emailVerified state.
  const handleCheckVerified = async () => {
    if (reloading) return;
    setReloading(true);
    try {
      await reloadUser();
    } finally {
      setReloading(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      className="flex items-center gap-2 px-4 py-2.5 text-[11px] flex-shrink-0"
      style={{
        background: 'rgba(245,158,11,0.08)',
        borderBottom: '1px solid rgba(245,158,11,0.15)',
      }}
    >
      <MailWarning size={13} className="text-amber-400 flex-shrink-0" />
      <span className="flex-1 text-amber-300/90 leading-relaxed min-w-0 truncate" dir="rtl">
        يرجى تأكيد بريدك الإلكتروني
      </span>
      <div className="flex items-center gap-2 flex-shrink-0">
        {sendError && (
          <span className="text-red-400 text-[10px]">{sendError}</span>
        )}
        {sent ? (
          <span className="text-emerald-400 font-medium">✓ أُرسل</span>
        ) : (
          <button
            onClick={handleResend}
            disabled={sending}
            className="text-[#00c6ff] font-semibold transition-opacity"
            style={{ opacity: sending ? 0.5 : 1 }}
          >
            {sending ? '...' : 'إرسال'}
          </button>
        )}
        <button
          onClick={handleCheckVerified}
          disabled={reloading}
          className="text-slate-400 font-medium transition-opacity border border-white/10 rounded-lg px-2 py-0.5"
          style={{ opacity: reloading ? 0.5 : 1 }}
          title="إذا تحققت من بريدك، اضغط هنا"
        >
          {reloading ? '...' : 'تحققت ✓'}
        </button>
      </div>
      <button
        onClick={() => setDismissed(true)}
        className="text-slate-600 flex-shrink-0"
        aria-label="dismiss"
      >
        <X size={12} />
      </button>
    </motion.div>
  );
}

// ─── App Content (authenticated) ─────────────────────────────────────────────

function AppContent() {
  const currentPage = useAppStore((s) => s.currentPage);

  const renderPage = () => {
    switch (currentPage) {
      case 'splash':             return <SplashScreen key="splash" />;
      case 'profile-setup':     return <ProfileSetupScreen key="profile-setup" />;
      case 'home':              return <HomeDashboard key="home" />;
      case 'flashcards':        return <FlashcardsPage key="flashcards" />;
      case 'focus':             return <FocusTimer key="focus" />;
      case 'chat':              return <AIChat key="chat" />;
      case 'search':            return <SearchPage key="search" />;
      case 'profile':           return <ProfilePage key="profile" />;
      case 'settings':          return <SettingsPage key="settings" />;
      case 'curriculum-manager': return <CurriculumManager key="curriculum-manager" />;
      default:                  return <HomeDashboard key="home" />;
    }
  };

  return (
    <div className="relative max-w-[430px] mx-auto min-h-screen overflow-hidden flex flex-col">
      <AnimatePresence>
        <EmailVerificationBanner />
      </AnimatePresence>
      <div className="flex-1 relative overflow-hidden">
        <AnimatePresence mode="wait">
          {renderPage()}
        </AnimatePresence>
        {!NO_NAV_PAGES.has(currentPage) && <BottomNav />}
      </div>
    </div>
  );
}

// ─── Root App ─────────────────────────────────────────────────────────────────

export default function App() {
  const { user, loading } = useAuth();

  if (loading) return <LoadingScreen />;

  if (!user) {
    return (
      <div className="relative max-w-[430px] mx-auto min-h-screen overflow-hidden">
        <LoginScreen />
      </div>
    );
  }

  return <AppContent />;
}
