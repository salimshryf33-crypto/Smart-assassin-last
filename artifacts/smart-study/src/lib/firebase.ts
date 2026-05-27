import { initializeApp, getApps } from 'firebase/app';
import { getAuth, GoogleAuthProvider, EmailAuthProvider } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: "AIzaSyAi9anuQIw5cVjYzrGSzfZm-QoWuCTU_FA",
  authDomain: "sage-78209.firebaseapp.com",
  projectId: "sage-78209",
  storageBucket: "sage-78209.firebasestorage.app",
  messagingSenderId: "1007529429917",
  appId: "1:1007529429917:web:281f998a6a694e0c58fd74",
  measurementId: "G-XKHQG5K531",
};

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];

export const auth = getAuth(app);
export const db = getFirestore(app);
export const googleProvider = new GoogleAuthProvider();
export const emailProvider = new EmailAuthProvider();

googleProvider.setCustomParameters({ prompt: 'select_account' });
