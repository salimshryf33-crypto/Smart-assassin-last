import { AnimatePresence } from 'framer-motion';
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
import { Brain } from 'lucide-react';

const NO_NAV_PAGES = new Set(['splash', 'profile-setup', 'login', 'curriculum-manager']);

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

function AppContent() {
  const currentPage = useAppStore((s) => s.currentPage);

  const renderPage = () => {
    switch (currentPage) {
      case 'splash': return <SplashScreen key="splash" />;
      case 'profile-setup': return <ProfileSetupScreen key="profile-setup" />;
      case 'home': return <HomeDashboard key="home" />;
      case 'flashcards': return <FlashcardsPage key="flashcards" />;
      case 'focus': return <FocusTimer key="focus" />;
      case 'chat': return <AIChat key="chat" />;
      case 'search': return <SearchPage key="search" />;
      case 'profile': return <ProfilePage key="profile" />;
      case 'settings': return <SettingsPage key="settings" />;
      case 'curriculum-manager': return <CurriculumManager key="curriculum-manager" />;
      default: return <HomeDashboard key="home" />;
    }
  };

  return (
    <div className="relative max-w-[430px] mx-auto min-h-screen overflow-hidden">
      <AnimatePresence mode="wait">
        {renderPage()}
      </AnimatePresence>
      {!NO_NAV_PAGES.has(currentPage) && <BottomNav />}
    </div>
  );
}

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
