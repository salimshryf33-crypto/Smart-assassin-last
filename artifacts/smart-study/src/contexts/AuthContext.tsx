import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import {
  User,
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
import { initUserDocument, loadUserDoc, loadChatMessages, loadFlashcards, loadTasks } from '../lib/firestore';
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

async function hydrateStore(uid: string) {
  const store = useAppStore.getState();

  try {
    const [userData, messages, flashcards, tasks] = await Promise.all([
      loadUserDoc(uid),
      loadChatMessages(uid),
      loadFlashcards(uid),
      loadTasks(uid),
    ]);

    if (userData?.userProfile) store.updateUserProfile(userData.userProfile);
    if (userData?.studentProfile) store.setStudentProfileDirect(userData.studentProfile);
    if (userData?.settings) store.updateSettings(userData.settings);
    if (messages.length > 0) store.hydrateChat(messages);
    if (flashcards.length > 0) store.hydrateFlashcards(flashcards);
    if (tasks.length > 0) store.hydrateTasks(tasks);
  } catch (err) {
    console.error('[Auth] Failed to hydrate store:', err);
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const resetStore = useAppStore((s) => s.resetStore);

  useEffect(() => {
    // Handle redirect result first (from signInWithRedirect)
    getRedirectResult(auth).catch(() => {});

    const unsub = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        setUser(firebaseUser);
        await initUserDocument(firebaseUser.uid, firebaseUser.displayName, firebaseUser.email);
        await hydrateStore(firebaseUser.uid);
      } else {
        setUser(null);
        resetStore();
      }
      setLoading(false);
    });
    return unsub;
  }, []);

  const signInWithGoogle = async () => {
    try {
      // Try popup first (works in most browsers)
      await signInWithPopup(auth, googleProvider);
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code ?? '';
      // If popup is blocked or not allowed, fall back to redirect
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
    await signOut(auth);
    resetStore();
  };

  return (
    <AuthContext.Provider value={{ user, loading, signInWithGoogle, signInWithEmail, signUpWithEmail, logout }}>
      {children}
    </AuthContext.Provider>
  );
}
