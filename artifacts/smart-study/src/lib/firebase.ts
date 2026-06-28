import { initializeApp, getApps } from 'firebase/app';
import { getAuth, GoogleAuthProvider, EmailAuthProvider } from 'firebase/auth';
import { getFirestore, initializeFirestore, persistentLocalCache } from 'firebase/firestore';
import { initializeAppCheck, ReCaptchaV3Provider, CustomProvider } from 'firebase/app-check';
import { setAppCheck } from './appCheckToken';

const firebaseConfig = {
  apiKey:            import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain:        import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId:         import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket:     import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId:             import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId:     import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
};

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];

// ─── App Check ────────────────────────────────────────────────────────────────
// Production : set VITE_RECAPTCHA_SITE_KEY (from Firebase Console → App Check)
// Dev testing: set VITE_APP_CHECK_DEBUG_TOKEN to use a fixed debug token
// No keys set: App Check skipped gracefully — app works normally
const _siteKey   = import.meta.env.VITE_RECAPTCHA_SITE_KEY   as string | undefined;
const _debugToken = import.meta.env.VITE_APP_CHECK_DEBUG_TOKEN as string | undefined;

if (_siteKey) {
  try {
    setAppCheck(initializeAppCheck(app, {
      provider: new ReCaptchaV3Provider(_siteKey),
      isTokenAutoRefreshEnabled: true,
    }));
  } catch { /* already initialized */ }
} else if (import.meta.env.DEV && _debugToken) {
  try {
    setAppCheck(initializeAppCheck(app, {
      provider: new CustomProvider({
        getToken: () => Promise.resolve({
          token: _debugToken,
          expireTimeMillis: Date.now() + 3_600_000,
        }),
      }),
      isTokenAutoRefreshEnabled: false,
    }));
  } catch { /* already initialized */ }
}

function getDb() {
  try {
    return initializeFirestore(app, { localCache: persistentLocalCache() });
  } catch {
    return getFirestore(app);
  }
}

export const auth = getAuth(app);
export const db = getDb();
export const googleProvider = new GoogleAuthProvider();
export const emailProvider = new EmailAuthProvider();

googleProvider.setCustomParameters({ prompt: 'select_account' });
