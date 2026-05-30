import { doc, runTransaction } from 'firebase/firestore';
import { db } from './firebase';
import type { GamificationData } from './gamification';
import { DEFAULT_GAMIFICATION } from './gamification';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DailyChecklist {
  date: string;
  taskDone: boolean;
  aiChatDone: boolean;
  cardReviewed: boolean;
  dailyCompleted: boolean;
}

export const DEFAULT_DAILY_CHECKLIST: DailyChecklist = {
  date: '',
  taskDone: false,
  aiChatDone: false,
  cardReviewed: false,
  dailyCompleted: false,
};

// ─── Timezone-aware date helpers ──────────────────────────────────────────────

const COUNTRY_TZ: Record<string, string> = {
  egypt: 'Africa/Cairo',
  sudan: 'Africa/Khartoum',
};

export function getDateForCountry(country: string): string {
  const tz = COUNTRY_TZ[country?.toLowerCase?.()] ?? 'Africa/Cairo';
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  } catch {
    const d = new Date();
    return [
      d.getFullYear(),
      String(d.getMonth() + 1).padStart(2, '0'),
      String(d.getDate()).padStart(2, '0'),
    ].join('-');
  }
}

export function getPreviousDay(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return [
    d.getUTCFullYear(),
    String(d.getUTCMonth() + 1).padStart(2, '0'),
    String(d.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

export function getLast28Days(today: string): string[] {
  const days: string[] = [];
  for (let i = 27; i >= 0; i--) {
    const d = new Date(today + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() - i);
    days.push([
      d.getUTCFullYear(),
      String(d.getUTCMonth() + 1).padStart(2, '0'),
      String(d.getUTCDate()).padStart(2, '0'),
    ].join('-'));
  }
  return days;
}

// ─── Validation ───────────────────────────────────────────────────────────────

export function isValidAIChatMessage(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 10) return false;
  // Reject pure symbols/punctuation/numbers with no Arabic or Latin letters
  if (/^[\s\W\d]+$/.test(trimmed)) return false;
  return true;
}

// ─── Streak expiry (timezone-aware) ──────────────────────────────────────────

export function checkStreakExpiryForCountry(
  gamification: GamificationData,
  country: string
): Partial<GamificationData> | null {
  if (!gamification.lastStreakDate || gamification.currentStreak === 0) return null;
  const today = getDateForCountry(country);
  const yesterday = getPreviousDay(today);
  if (gamification.lastStreakDate < yesterday) {
    console.log('[StreakEngine] Streak expired. Last active:', gamification.lastStreakDate);
    return { currentStreak: 0 };
  }
  return null;
}

// ─── Checklist flag update (transactional, idempotent) ───────────────────────

export async function updateChecklistFlag(
  uid: string,
  today: string,
  flag: 'taskDone' | 'aiChatDone' | 'cardReviewed'
): Promise<DailyChecklist> {
  const userRef = doc(db, 'users', uid);

  return runTransaction(db, async (tx) => {
    const snap = await tx.get(userRef);
    const data = snap.data() ?? {};

    let checklist: DailyChecklist = {
      ...DEFAULT_DAILY_CHECKLIST,
      ...(data.dailyChecklist ?? {}),
    };

    // Reset for new day
    if (checklist.date !== today) {
      checklist = { ...DEFAULT_DAILY_CHECKLIST, date: today };
    }

    // Day already completed — return current state, no write
    if (checklist.dailyCompleted) return checklist;

    // Flag already set — return current state, no write
    if (checklist[flag]) return checklist;

    const updated: DailyChecklist = { ...checklist, [flag]: true };
    tx.set(userRef, { dailyChecklist: updated }, { merge: true });
    return updated;
  });
}

// ─── Atomic streak completion (single Firestore transaction) ─────────────────

export async function atomicCompleteDay(
  uid: string,
  today: string
): Promise<{ streakIncremented: boolean; newStreak: number; newLongest: number }> {
  const userRef = doc(db, 'users', uid);

  try {
    return await runTransaction(db, async (tx) => {
      const snap = await tx.get(userRef);
      const data = snap.data() ?? {};

      const checklist: DailyChecklist = {
        ...DEFAULT_DAILY_CHECKLIST,
        ...(data.dailyChecklist ?? {}),
      };
      const gamification: GamificationData = {
        ...DEFAULT_GAMIFICATION,
        ...(data.gamification ?? {}),
      };

      // Guard: already completed today
      if (checklist.dailyCompleted && checklist.date === today) {
        return {
          streakIncremented: false,
          newStreak: gamification.currentStreak,
          newLongest: gamification.longestStreak,
        };
      }

      // Guard: lastStreakDate already set to today (extra safety)
      if (gamification.lastStreakDate === today) {
        return {
          streakIncremented: false,
          newStreak: gamification.currentStreak,
          newLongest: gamification.longestStreak,
        };
      }

      // Guard: checklist not for today (shouldn't happen but be safe)
      if (checklist.date !== today) {
        return {
          streakIncremented: false,
          newStreak: gamification.currentStreak,
          newLongest: gamification.longestStreak,
        };
      }

      // Compute new streak value
      const lastDate = gamification.lastStreakDate ?? '';
      const yesterday = getPreviousDay(today);
      let newStreak: number;

      if (!lastDate) {
        newStreak = 1;
      } else if (lastDate === yesterday) {
        newStreak = (gamification.currentStreak ?? 0) + 1;
      } else {
        // Gap: reset to 1
        console.log('[StreakEngine] Streak gap detected. Last:', lastDate, 'Today:', today);
        newStreak = 1;
      }

      const newLongest = Math.max(gamification.longestStreak ?? 0, newStreak);

      // Update streakHistory: keep last 35 days
      const history: string[] = Array.isArray(gamification.streakHistory)
        ? [...gamification.streakHistory]
        : [];
      if (!history.includes(today)) history.push(today);

      const cutoff = new Date(today + 'T12:00:00Z');
      cutoff.setUTCDate(cutoff.getUTCDate() - 35);
      const cutoffStr = [
        cutoff.getUTCFullYear(),
        String(cutoff.getUTCMonth() + 1).padStart(2, '0'),
        String(cutoff.getUTCDate()).padStart(2, '0'),
      ].join('-');
      const trimmedHistory = history.filter((d) => d >= cutoffStr);

      const updatedChecklist: DailyChecklist = {
        ...checklist,
        date: today,
        dailyCompleted: true,
      };

      const updatedGamification: GamificationData = {
        ...gamification,
        currentStreak: newStreak,
        longestStreak: newLongest,
        lastStreakDate: today,
        lastActiveTimestamp: Date.now(),
        streakHistory: trimmedHistory,
      };

      tx.set(
        userRef,
        { dailyChecklist: updatedChecklist, gamification: updatedGamification },
        { merge: true }
      );

      console.log('[StreakEngine] Day completed atomically. Streak:', newStreak);
      return { streakIncremented: true, newStreak, newLongest };
    });
  } catch (err) {
    console.error('[StreakEngine] atomicCompleteDay failed — rolling back:', err);
    return { streakIncremented: false, newStreak: 0, newLongest: 0 };
  }
}
