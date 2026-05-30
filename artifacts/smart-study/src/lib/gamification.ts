import {
  doc,
  setDoc,
  getDoc,
  onSnapshot,
  Unsubscribe,
} from 'firebase/firestore';
import { db } from './firebase';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DailyCap {
  flashcardXP: number;
  chatXP: number;
}

export interface GamificationData {
  currentStreak: number;
  longestStreak: number;
  lastStreakDate: string;
  lastActiveTimestamp: number;
  xp: number;
  totalXP: number;
  hasSeenStreakTooltip: boolean;
  dailyCaps: Record<string, DailyCap>;
}

export type ActivityType = 'task' | 'flashcard' | 'ai_chat' | 'focus_session';

// ─── XP Config ────────────────────────────────────────────────────────────────

export const XP_VALUES: Record<ActivityType, number> = {
  task: 10,
  flashcard: 5,
  ai_chat: 5,
  focus_session: 15,
};

const DAILY_XP_CAP: Partial<Record<ActivityType, number>> = {
  flashcard: 50,
  ai_chat: 25,
};

const GRACE_HOURS = 2;

// ─── Defaults ─────────────────────────────────────────────────────────────────

export const DEFAULT_GAMIFICATION: GamificationData = {
  currentStreak: 0,
  longestStreak: 0,
  lastStreakDate: '',
  lastActiveTimestamp: 0,
  xp: 0,
  totalXP: 0,
  hasSeenStreakTooltip: false,
  dailyCaps: {},
};

// ─── Date helpers ─────────────────────────────────────────────────────────────

export function getLocalDateString(timestamp = Date.now()): string {
  const d = new Date(timestamp);
  if (d.getHours() < GRACE_HOURS) {
    d.setDate(d.getDate() - 1);
  }
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getPreviousDayString(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() - 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ─── Pure computation helpers ─────────────────────────────────────────────────

export function computeStreakUpdate(
  current: GamificationData,
  today: string
): Partial<GamificationData> | null {
  if (current.lastStreakDate === today) {
    return { lastActiveTimestamp: Date.now() };
  }

  const yesterday = getPreviousDayString(today);
  let newStreak: number;

  if (!current.lastStreakDate || current.lastStreakDate === yesterday) {
    newStreak = !current.lastStreakDate ? 1 : current.currentStreak + 1;
    console.log('[Gamification] Streak incremented to:', newStreak);
  } else {
    newStreak = 1;
    console.log('[Gamification] Streak reset: last active', current.lastStreakDate, '— new streak:', newStreak);
  }

  const newLongest = Math.max(current.longestStreak, newStreak);
  return {
    currentStreak: newStreak,
    longestStreak: newLongest,
    lastStreakDate: today,
    lastActiveTimestamp: Date.now(),
  };
}

export function checkStreakExpiry(current: GamificationData): Partial<GamificationData> | null {
  if (!current.lastStreakDate || current.currentStreak === 0) return null;

  const today = getLocalDateString();
  const yesterday = getPreviousDayString(today);

  if (current.lastStreakDate < yesterday) {
    console.log('[Gamification] Streak reset: inactivity detected. Last active:', current.lastStreakDate);
    return { currentStreak: 0 };
  }
  return null;
}

export function computeXPGrant(
  current: GamificationData,
  type: ActivityType,
  today: string
): { xpGained: number; updates: Partial<GamificationData> } {
  const xpValue = XP_VALUES[type];
  const cap = DAILY_XP_CAP[type];

  if (cap !== undefined) {
    const caps: DailyCap = current.dailyCaps?.[today] ?? { flashcardXP: 0, chatXP: 0 };
    const key = type === 'flashcard' ? 'flashcardXP' : 'chatXP';
    const used = caps[key] ?? 0;

    if (used >= cap) {
      console.log('[Gamification] Daily XP cap reached for', type);
      return { xpGained: 0, updates: {} };
    }

    const newCaps: DailyCap = { ...caps, [key]: used + xpValue };
    const cutoff = getPreviousDayString(getPreviousDayString(getPreviousDayString(
      getPreviousDayString(getPreviousDayString(getPreviousDayString(getPreviousDayString(today)))))));
    const cleanedCaps: Record<string, DailyCap> = {};
    Object.entries({ ...(current.dailyCaps ?? {}), [today]: newCaps }).forEach(([d, v]) => {
      if (d >= cutoff) cleanedCaps[d] = v;
    });

    const newXP = (current.xp ?? 0) + xpValue;
    const newTotalXP = (current.totalXP ?? 0) + xpValue;
    console.log('[Gamification] XP granted:', xpValue, 'for', type, '| Total XP:', newTotalXP);
    return { xpGained: xpValue, updates: { xp: newXP, totalXP: newTotalXP, dailyCaps: cleanedCaps } };
  }

  const newXP = (current.xp ?? 0) + xpValue;
  const newTotalXP = (current.totalXP ?? 0) + xpValue;
  console.log('[Gamification] XP granted:', xpValue, 'for', type, '| Total XP:', newTotalXP);
  return { xpGained: xpValue, updates: { xp: newXP, totalXP: newTotalXP } };
}

// ─── Offline queue ────────────────────────────────────────────────────────────

const QUEUE_KEY = 'sage_gamification_queue';

interface QueuedUpdate {
  uid: string;
  updates: Partial<GamificationData>;
  timestamp: number;
}

function enqueueOfflineUpdate(uid: string, updates: Partial<GamificationData>) {
  try {
    const raw = localStorage.getItem(QUEUE_KEY) ?? '[]';
    const queue: QueuedUpdate[] = JSON.parse(raw);
    queue.push({ uid, updates, timestamp: Date.now() });
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue.slice(-20)));
  } catch {}
}

export async function flushOfflineQueue(uid: string): Promise<void> {
  try {
    const raw = localStorage.getItem(QUEUE_KEY) ?? '[]';
    const queue: QueuedUpdate[] = JSON.parse(raw);
    const mine = queue.filter((q) => q.uid === uid);
    if (mine.length === 0) return;

    const merged = mine.reduce((acc, q) => ({ ...acc, ...q.updates }), {} as Partial<GamificationData>);
    await setDoc(doc(db, 'users', uid), { gamification: merged }, { merge: true });
    console.log('[Gamification] Offline queue flushed:', Object.keys(merged));

    const remaining = queue.filter((q) => q.uid !== uid);
    localStorage.setItem(QUEUE_KEY, JSON.stringify(remaining));
  } catch {}
}

// ─── Firestore operations ─────────────────────────────────────────────────────

export async function saveGamification(
  uid: string,
  updates: Partial<GamificationData>
): Promise<void> {
  try {
    await setDoc(doc(db, 'users', uid), { gamification: updates }, { merge: true });
    console.log('[Gamification] Firestore update success:', Object.keys(updates));
  } catch (err) {
    console.error('[Gamification] Firestore write failed — queuing offline:', err);
    enqueueOfflineUpdate(uid, updates);
  }
}

export async function loadGamification(uid: string): Promise<GamificationData> {
  await flushOfflineQueue(uid);
  const snap = await getDoc(doc(db, 'users', uid));
  if (!snap.exists()) return DEFAULT_GAMIFICATION;
  const data = snap.data();
  return { ...DEFAULT_GAMIFICATION, ...(data?.gamification ?? {}) };
}

export function subscribeToGamification(
  uid: string,
  onData: (data: GamificationData) => void
): Unsubscribe {
  return onSnapshot(
    doc(db, 'users', uid),
    (snap) => {
      if (snap.exists()) {
        const raw = snap.data();
        const gamification: GamificationData = {
          ...DEFAULT_GAMIFICATION,
          ...(raw?.gamification ?? {}),
        };
        onData(gamification);
      }
    },
    (err) => {
      console.error('[Gamification] onSnapshot error:', err);
    }
  );
}

export async function markTooltipSeen(uid: string): Promise<void> {
  await saveGamification(uid, { hasSeenStreakTooltip: true });
}
