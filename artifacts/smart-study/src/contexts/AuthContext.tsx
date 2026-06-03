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
  reauthenticateWithPopup,
  reauthenticateWithCredential,
  EmailAuthProvider,
  sendEmailVerification,
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

// ─── Types ────────────────────────────────────────────────────────────────────

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  signInWithGoogle: () => Promise<void>;
  signInWithEmail: (email: string, password: string) => Promise<void>;
  signUpWithEmail: (email: string, password: string, name: string) => Promise<void>;
  logout: () => Promise<void>;
  /**
   * Permanently deletes all Firestore data then deletes the Firebase Auth user.
   * On `auth/requires-recent-login`:
   *   - Google users: automatically triggers reauthenticateWithPopup then retries.
   *   - Email users: throws `auth/needs-reauth-password` if no password supplied.
   *                  Caller should collect the password and retry with it.
   */
  deleteAccount: (reauthPassword?: string) => Promise<void>;
  /**
   * Send / resend a verification email to the current email user.
   * No-op (safe to call) for Google users.
   */
  resendVerificationEmail: () => Promise<void>;
}

// ─── Context ──────────────────────────────────────────────────────────────────

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

// ─── Provider ─────────────────────────────────────────────────────────────────

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
    // NOT silently swallowed — errors are logged so auth/unauthorized-domain is visible.
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
        console.log(
          '[Auth] User signed in — uid:', firebaseUser.uid,
          '| provider:', firebaseUser.providerData[0]?.providerId,
          '| emailVerified:', firebaseUser.emailVerified
        );
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

  // ─── Auth Actions ────────────────────────────────────────────────────────────

  const signInWithGoogle = async () => {
    try {
      console.log('[Auth] Starting Google sign-in (popup)...');
      await signInWithPopup(auth, googleProvider);
      console.log('[Auth] Google popup sign-in succeeded');
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code ?? '';
      const message = (err as Error)?.message ?? String(err);
      console.error('[Auth] signInWithPopup error — code:', code, '| message:', message, '| full:', err);
      if (
        code === 'auth/popup-blocked' ||
        code === 'auth/popup-closed-by-user' ||
        code === 'auth/cancelled-popup-request'
      ) {
        console.log('[Auth] Popup blocked/closed — falling back to signInWithRedirect');
        await signInWithRedirect(auth, googleProvider);
      } else {
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
      // Send verification email immediately after signup.
      // Non-blocking: if it fails the account was still created successfully.
      try {
        await sendEmailVerification(cred.user);
        console.log('[Auth] Verification email sent to:', email);
      } catch (verifyErr) {
        console.warn('[Auth] sendEmailVerification failed (non-fatal):', verifyErr);
      }
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
   * Resend a verification email to the current signed-in email user.
   * Safe to call for Google users — exits immediately (they are always verified).
   */
  const resendVerificationEmail = async () => {
    const currentUser = auth.currentUser;
    if (!currentUser) return;
    const providerId = currentUser.providerData[0]?.providerId;
    if (providerId !== 'password') return; // Google users don't need this
    if (currentUser.emailVerified) return;
    try {
      await sendEmailVerification(currentUser);
      console.log('[Auth] Verification email resent to:', currentUser.email);
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code ?? 'unknown';
      console.error('[Auth] resendVerificationEmail error — code:', code, '| full:', err);
      throw err;
    }
  };

  /**
   * Permanently delete the current user's account and all associated Firestore data.
   *
   * Re-authentication handling (Firebase requires recent login for deleteUser):
   * - Google users: reauthenticateWithPopup is called automatically, then deletion retries.
   * - Email users: caller must supply `reauthPassword`. If omitted when required,
   *   throws `auth/needs-reauth-password` as a signal to the UI to collect the password.
   */
  const deleteAccount = async (reauthPassword?: string) => {
    const currentUser = auth.currentUser;
    if (!currentUser) {
      throw Object.assign(new Error('No authenticated user found'), { code: 'auth/no-current-user' });
    }

    const uid = currentUser.uid;
    const providerId = currentUser.providerData[0]?.providerId ?? 'password';
    console.log('[Auth] deleteAccount — uid:', uid, '| provider:', providerId);

    cleanupListeners();

    const performDelete = async () => {
      await deleteUserData(uid);
      console.log('[Auth] deleteAccount — Firestore data purged');
      await deleteUser(currentUser);
      resetStore();
      console.log('[Auth] deleteAccount — Auth user deleted, account fully removed');
    };

    try {
      await performDelete();
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code ?? '';
      console.error('[Auth] deleteAccount error — code:', code, '| full:', err);

      if (code === 'auth/requires-recent-login') {
        // ── Re-authenticate then retry ──────────────────────────────────────
        if (providerId === 'google.com') {
          console.log('[Auth] deleteAccount — re-authenticating via Google popup...');
          await reauthenticateWithPopup(currentUser, googleProvider);
          console.log('[Auth] deleteAccount — Google re-auth succeeded, retrying deletion...');
        } else if (providerId === 'password') {
          if (!reauthPassword) {
            // Signal to the UI: collect the password and retry with it
            throw Object.assign(
              new Error('Password required for re-authentication'),
              { code: 'auth/needs-reauth-password' }
            );
          }
          const credential = EmailAuthProvider.credential(currentUser.email!, reauthPassword);
          console.log('[Auth] deleteAccount — re-authenticating with email credential...');
          await reauthenticateWithCredential(currentUser, credential);
          console.log('[Auth] deleteAccount — email re-auth succeeded, retrying deletion...');
        } else {
          throw err;
        }
        // Retry after successful re-auth
        await performDelete();
      } else {
        throw err;
      }
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        signInWithGoogle,
        signInWithEmail,
        signUpWithEmail,
        logout,
        deleteAccount,
        resendVerificationEmail,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
