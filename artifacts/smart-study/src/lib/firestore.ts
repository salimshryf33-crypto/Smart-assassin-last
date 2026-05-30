import {
  doc,
  getDoc,
  setDoc,
  collection,
  getDocs,
  addDoc,
  deleteDoc,
  query,
  orderBy,
  writeBatch,
  serverTimestamp,
  onSnapshot,
  Unsubscribe,
} from 'firebase/firestore';
import { db } from './firebase';
import type { Flashcard, Task, ChatMessage, UserProfile, StudentProfile, Settings } from '../store/useAppStore';

// ─── Path helpers ────────────────────────────────────────────
const userDoc = (uid: string) => doc(db, 'users', uid);
const messagesCol = (uid: string) => collection(db, 'users', uid, 'messages');
const flashcardsCol = (uid: string) => collection(db, 'users', uid, 'flashcards');
const tasksCol = (uid: string) => collection(db, 'users', uid, 'tasks');

// ─── User profile ─────────────────────────────────────────────
export async function loadUserDoc(uid: string) {
  const snap = await getDoc(userDoc(uid));
  return snap.exists() ? snap.data() : null;
}

export async function saveStudentProfile(uid: string, profile: StudentProfile) {
  await setDoc(userDoc(uid), { studentProfile: profile }, { merge: true });
}

export async function saveUserProfile(uid: string, profile: Partial<UserProfile>) {
  await setDoc(userDoc(uid), { userProfile: profile }, { merge: true });
}

export async function saveSettings(uid: string, settings: Partial<Settings>) {
  await setDoc(userDoc(uid), { settings }, { merge: true });
}

export async function updateStreakFS(
  uid: string,
  streak: number,
  totalSessions: number,
  lastStudyDate: string
) {
  await setDoc(
    userDoc(uid),
    { userProfile: { streak, totalSessions, lastStudyDate } },
    { merge: true }
  );
}

export async function updateProgressFS(uid: string, updates: Partial<UserProfile>) {
  await setDoc(userDoc(uid), { userProfile: updates }, { merge: true });
}

// ─── Real-time subscriptions ──────────────────────────────────
export function subscribeToUserDoc(
  uid: string,
  onData: (data: {
    userProfile?: Partial<UserProfile>;
    studentProfile?: StudentProfile;
    settings?: Partial<Settings>;
    dailyChecklist?: Record<string, unknown>;
  } | null) => void
): Unsubscribe {
  return onSnapshot(
    userDoc(uid),
    (snap) => {
      if (snap.exists()) {
        onData(snap.data() as {
          userProfile?: Partial<UserProfile>;
          studentProfile?: StudentProfile;
          settings?: Partial<Settings>;
          dailyChecklist?: Record<string, unknown>;
        });
      } else {
        onData(null);
      }
    },
    (err) => {
      console.error('[Firestore] subscribeToUserDoc error:', err);
    }
  );
}

export function subscribeToFlashcards(
  uid: string,
  onData: (cards: Flashcard[]) => void
): Unsubscribe {
  return onSnapshot(
    flashcardsCol(uid),
    (snap) => {
      const cards = snap.docs.map((d) => ({ id: d.id, ...d.data() } as Flashcard));
      onData(cards);
    },
    (err) => {
      console.error('[Firestore] subscribeToFlashcards error:', err);
    }
  );
}

export function subscribeToTasks(
  uid: string,
  onData: (tasks: Task[]) => void
): Unsubscribe {
  return onSnapshot(
    tasksCol(uid),
    (snap) => {
      const tasks = snap.docs.map((d) => ({ id: d.id, ...d.data() } as Task));
      tasks.sort((a, b) => b.createdAt - a.createdAt);
      onData(tasks);
    },
    (err) => {
      console.error('[Firestore] subscribeToTasks error:', err);
    }
  );
}

// ─── Chat messages ────────────────────────────────────────────
export async function loadChatMessages(uid: string): Promise<ChatMessage[]> {
  const q = query(messagesCol(uid), orderBy('timestamp', 'asc'));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as ChatMessage));
}

export async function addChatMessageFS(uid: string, msg: Omit<ChatMessage, 'id'>): Promise<string> {
  const ref = await addDoc(messagesCol(uid), { ...msg, createdAt: serverTimestamp() });
  return ref.id;
}

export async function clearChatMessages(uid: string) {
  const snap = await getDocs(messagesCol(uid));
  const batch = writeBatch(db);
  snap.docs.forEach((d) => batch.delete(d.ref));
  await batch.commit();
}

// ─── Flashcards ───────────────────────────────────────────────
export async function loadFlashcards(uid: string): Promise<Flashcard[]> {
  const snap = await getDocs(flashcardsCol(uid));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as Flashcard));
}

export async function saveFlashcard(uid: string, card: Flashcard) {
  await setDoc(doc(flashcardsCol(uid), card.id), card);
}

export async function deleteFlashcardFS(uid: string, cardId: string) {
  await deleteDoc(doc(flashcardsCol(uid), cardId));
}

// ─── Tasks ────────────────────────────────────────────────────
export async function loadTasks(uid: string): Promise<Task[]> {
  const snap = await getDocs(tasksCol(uid));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as Task));
}

export async function saveTask(uid: string, task: Task) {
  await setDoc(doc(tasksCol(uid), task.id), task);
}

export async function deleteTaskFS(uid: string, taskId: string) {
  await deleteDoc(doc(tasksCol(uid), taskId));
}

export async function updateTaskFS(uid: string, task: Task) {
  await setDoc(doc(tasksCol(uid), task.id), task);
}

// ─── Initialize new user document ────────────────────────────
export async function initUserDocument(
  uid: string,
  displayName: string | null,
  email: string | null
) {
  const existing = await getDoc(userDoc(uid));
  if (!existing.exists()) {
    await setDoc(userDoc(uid), {
      userProfile: {
        name: displayName ?? 'Student',
        avatar: '',
        studyGoal: '',
        curriculum: '',
        streak: 0,
        totalSessions: 0,
        lastStudyDate: new Date().toDateString(),
      },
      studentProfile: {
        country: '',
        level: '',
        track: '',
        profileComplete: false,
      },
      settings: {
        language: 'Arabic',
        curriculum: '',
        fontSize: 'medium',
        darkMode: true,
        notifications: true,
      },
      email,
      createdAt: serverTimestamp(),
    });
  }
}
