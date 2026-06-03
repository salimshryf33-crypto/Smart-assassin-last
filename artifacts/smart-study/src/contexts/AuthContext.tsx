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
  deleteUser,
} from 'firebase/auth';
import { auth, googleProvider } from '../lib/firebase';
import {
  initUserDocument,
  loadChatMessages,
  subscribeToUserDoc,
  subscribeToFlashcards,
  subscribeToTasks,
  deleteUserData,
} from '../lib/firestore';
import { subscribeToGamification, flushOfflineQueue } from '../lib/gamification';
import { DEFAULT_DAILY_CHECKLIST } from '../lib/streakEngine';
import { useAppStore } from '../store/useAppStore';

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  signInWithGoogle: () => Promise<void>;
  signInWithEmail: (email: string, password: string) => Promise<void>;
  signUpWithEmail: (email: string, password: string, name: string) => Promise<void>;
  logout: () => Promise<void>;
  deleteAccount: () => Promise<void>;
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
    await flushOfflineQueue(uid);

    const store = useAppStore.getState();

    const unsubUserDoc = subscribeToUserDoc(uid, (data) => {
      if (!data) return;
      if (data.userProfile) {
        store.updateUserProfile(data.userProfile as Parameters<typeof store.updateUserProfile>[0]);
      }
      if (data.studentProfile) {
        store.setStudentProfileDirect(data.studentProfile);
      }
      if (data.settings) {
        store.updateSettings(data.settings as Parameters<typeof store.updateSettings>[0]);
      }
      // Hydrate dailyChecklist from Firestore — single source of truth
      if (data.dailyChecklist) {
        store.hydrateDailyChecklist({
          ...DEFAULT_DAILY_CHECKLIST,
          ...(data.dailyChecklist as object),
        });
      }
    });

    const unsubFlashcards = subscribeToFlashcards(uid, (cards) => {
      store.hydrateFlashcards(cards);
    });

    const unsubTasks = subscribeToTasks(uid, (tasks) => {
      store.hydrateTasks(tasks);
    });

    const unsubGamification = subscribeToGamification(uid, (data) => {
      store.hydrateGamification(data);
    });

    unsubscribersRef.current = [unsubUserDoc, unsubFlashcards, unsubTasks, unsubGamification];

    try {
      const messages = await loadChatMessages(uid);
      store.hydrateChat(messages);
    } catch (err) {
      console.error('[Auth] Failed to load chat messages:', err);
      store.hydrateChat([]);
    }
  }

  useEffect(() => {
    // Handle redirect result on initial load (fallback from signInWithRedirect).
    // Must NOT be silently swallowed — log errors so auth/unauthorized-domain
    // and similar failures are visible in the console.
    getRedirectResult(auth)
      .then((result) => {
        if (result?.user) {
          console.log('[Auth] Redirect sign-in completed — uid:', result.user.uid);
        }
      })
      .catch((err: unknown) => {
        const code = (err as { code?: string })?.code ?? 'unknown';
        const message = (err as Error)?.message ?? String(err);
        console.error(
          '[Auth] getRedirectResult error — code:', code,
          '| message:', message,
          '| full:', err
        );
      });

    const unsub = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        console.log('[Auth] User signed in — uid:', firebaseUser.uid, '| provider:', firebaseUser.providerData[0]?.providerId);
        setUser(firebaseUser);
        await initUserDocument(firebaseUser.uid, firebaseUser.displayName, firebaseUser.email);
        await setupRealtimeListeners(firebaseUser.uid);
      } else {
        console.log('[Auth] User signed out');
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
      console.log('[Auth] Starting Google sign-in (popup)...');
      await signInWithPopup(auth, googleProvider);
      console.log('[Auth] Google popup sign-in succeeded');
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code ?? '';
      const message = (err as Error)?.message ?? String(err);
      console.error(
        '[Auth] signInWithPopup error — code:', code,
        '| message:', message,
        '| full:', err
      );
      if (
        code === 'auth/popup-blocked' ||
        code === 'auth/popup-closed-by-user' ||
        code === 'auth/cancelled-popup-request'
      ) {
        console.log('[Auth] Popup blocked/closed — falling back to signInWithRedirect');
        await signInWithRedirect(auth, googleProvider);
      } else {
        // Re-throw so LoginScreen can surface the correct code-based message
        throw err;
      }
    }
  };

  const signInWithEmail = async (email: string, password: string) => {
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code ?? 'unknown';
      const message = (err as Error)?.message ?? String(err);
      console.error('[Auth] signInWithEmail error — code:', code, '| message:', message);
      throw err;
    }
  };

  const signUpWithEmail = async (email: string, password: string, name: string) => {
    try {
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      await updateProfile(cred.user, { displayName: name });
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code ?? 'unknown';
      const message = (err as Error)?.message ?? String(err);
      console.error('[Auth] signUpWithEmail error — code:', code, '| message:', message);
      throw err;
    }
  };

  const logout = async () => {
    cleanupListeners();
    await signOut(auth);
    resetStore();
  };

  /**
   * Permanently delete the current user's account and all associated data.
   * Requires the user to be recently signed in (Firebase re-auth policy).
   * Order: delete Firestore data first → then delete Auth user.
   */
  const deleteAccount = async () => {
    const currentUser = auth.currentUser;
    if (!currentUser) {
      throw Object.assign(new Error('No authenticated user found'), { code: 'auth/no-current-user' });
    }
    const uid = currentUser.uid;
    console.log('[Auth] deleteAccount — deleting Firestore data for uid:', uid);
    cleanupListeners();
    try {
      await deleteUserData(uid);
      console.log('[Auth] deleteAccount — Firestore data deleted, deleting Auth user...');
      await deleteUser(currentUser);
      resetStore();
      console.log('[Auth] deleteAccount — account fully deleted');
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code ?? 'unknown';
      const message = (err as Error)?.message ?? String(err);
      console.error('[Auth] deleteAccount error — code:', code, '| message:', message, '| full:', err);
      throw err;
    }
  };

  return (
    <AuthContext.Provider value={{ user, loading, signInWithGoogle, signInWithEmail, signUpWithEmail, logout, deleteAccount }}>
      {children}
    </AuthContext.Provider>
  );
}
