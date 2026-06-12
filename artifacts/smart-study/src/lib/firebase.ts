import { initializeApp, getApps } from 'firebase/app';
import { getAuth, GoogleAuthProvider, EmailAuthProvider } from 'firebase/auth';
import { getFirestore, initializeFirestore, persistentLocalCache } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? "AIzaSyAi9anuQIw5cVjYzrGSzfZm-QoWuCTU_FA",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? "sage-78209.firebaseapp.com",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ?? "sage-78209",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET ?? "sage-78209.firebasestorage.app",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? "1007529429917",
  appId: import.meta.env.VITE_FIREBASE_APP_ID ?? "1:1007529429917:web:281f998a6a694e0c58fd74",
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID ?? "G-XKHQG5K531",
};

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];

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
