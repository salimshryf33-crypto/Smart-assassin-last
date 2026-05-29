import { createContext, useContext, useEffect, useRef, useState, ReactNode } from 'react';
import {
  User,
  Unsubscribe,
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  updateProfile,
} from 'firebase/auth';
import { auth, googleProvider } from '../lib/firebase';
import {
  initUserDocument,
  loadChatMessages,
  subscribeToUserDoc,
  subscribeToFlashcards,
  subscribeToTasks,
} from '../lib/firestore';
import { useAppStore } from '../store/useAppStore';

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  signInWithGoogle: () => Promise<void>;
  signInWithEmail: (email: string, password: string) => Promise<void>;
  signUpWithEmail: (email: string, password: string, name: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const resetStore = useAppStore((s) => s.resetStore);

  const unsubscribersRef = useRef<Unsubscribe[]>([]);

  function cleanupListeners() {
    unsubscribersRef.current.forEach((fn) => fn());
    unsubscribersRef.current = [];
  }

  async function setupRealtimeListeners(uid: string) {
    cleanupListeners();

    const store = useAppStore.getState();

    const unsubUserDoc = subscribeToUserDoc(uid, (data) => {
      if (!data) return;
      if (data.userProfile) store.updateUserProfile(data.userProfile as Parameters<typeof store.updateUserProfile>[0]);
      if (data.studentProfile) store.setStudentProfileDirect(data.studentProfile);
      if (data.settings) store.updateSettings(data.settings as Parameters<typeof store.updateSettings>[0]);
    });

    const unsubFlashcards = subscribeToFlashcards(uid, (cards) => {
      store.hydrateFlashcards(cards);
    });

    const unsubTasks = subscribeToTasks(uid, (tasks) => {
      store.hydrateTasks(tasks);
    });

    unsubscribersRef.current = [unsubUserDoc, unsubFlashcards, unsubTasks];

    try {
      const messages = await loadChatMessages(uid);
      if (messages.length > 0) store.hydrateChat(messages);
    } catch (err) {
      console.error('[Auth] Failed to load chat messages:', err);
    }
  }

  useEffect(() => {
    getRedirectResult(auth).catch(() => {});

    const unsub = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        setUser(firebaseUser);
        await initUserDocument(firebaseUser.uid, firebaseUser.displayName, firebaseUser.email);
        await setupRealtimeListeners(firebaseUser.uid);
      } else {
        cleanupListeners();
        setUser(null);
        resetStore();
      }
      setLoading(false);
    });

    return () => {
      unsub();
      cleanupListeners();
    };
  }, []);

  const signInWithGoogle = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code ?? '';
      if (
        code === 'auth/popup-blocked' ||
        code === 'auth/popup-closed-by-user' ||
        code === 'auth/cancelled-popup-request'
      ) {
        await signInWithRedirect(auth, googleProvider);
      } else {
        throw err;
      }
    }
  };

  const signInWithEmail = async (email: string, password: string) => {
    await signInWithEmailAndPassword(auth, email, password);
  };

  const signUpWithEmail = async (email: string, password: string, name: string) => {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    await updateProfile(cred.user, { displayName: name });
  };

  const logout = async () => {
    cleanupListeners();
    await signOut(auth);
    resetStore();
  };

  return (
    <AuthContext.Provider value={{ user, loading, signInWithGoogle, signInWithEmail, signUpWithEmail, logout }}>
      {children}
    </AuthContext.Provider>
  );
}
