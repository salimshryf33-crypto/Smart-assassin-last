import { useRef, useCallback } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useAppStore } from '../store/useAppStore';
import {
  ActivityType,
  computeStreakUpdate,
  computeXPGrant,
  checkStreakExpiry,
  saveGamification,
  getLocalDateString,
} from '../lib/gamification';

const AI_CHAT_MIN_LENGTH = 30;
const AI_CHAT_DEBOUNCE_MS = 30_000;

export function useStreak() {
  const { user } = useAuth();
  const gamification = useAppStore((s) => s.gamification);
  const updateGamification = useAppStore((s) => s.updateGamification);

  const lastActivityRef = useRef<Partial<Record<ActivityType, number>>>({});

  const recordActivity = useCallback(
    async (type: ActivityType, options?: { taskId?: string; messageLength?: number }) => {
      if (!user?.uid) return;

      console.log('[Gamification] Activity detected:', type);

      if (type === 'ai_chat') {
        const len = options?.messageLength ?? 0;
        if (len < AI_CHAT_MIN_LENGTH) {
          console.log('[Gamification] AI chat skipped: message too short', len);
          return;
        }
        const last = lastActivityRef.current.ai_chat ?? 0;
        if (Date.now() - last < AI_CHAT_DEBOUNCE_MS) {
          console.log('[Gamification] AI chat skipped: debounce');
          return;
        }
        lastActivityRef.current.ai_chat = Date.now();
      }

      if (type === 'task') {
        const taskId = options?.taskId;
        if (!taskId) return;

        const today = getLocalDateString();
        const storageKey = `sage_tasks_${user.uid}_${today}`;
        let completedToday: Set<string>;
        try {
          completedToday = new Set<string>(JSON.parse(localStorage.getItem(storageKey) ?? '[]'));
        } catch {
          completedToday = new Set<string>();
        }

        if (completedToday.has(taskId)) {
          console.log('[Gamification] Task already counted today:', taskId);
          return;
        }

        completedToday.add(taskId);
        try {
          localStorage.setItem(storageKey, JSON.stringify([...completedToday]));
        } catch {}
      }

      const today = getLocalDateString();
      const streakTriggers: ActivityType[] = ['task', 'flashcard', 'focus_session'];

      let streakUpdates: Partial<ReturnType<typeof computeStreakUpdate>> = {};
      if (streakTriggers.includes(type)) {
        const result = computeStreakUpdate(gamification, today);
        if (result) streakUpdates = result;
      }

      const { xpGained, updates: xpUpdates } = computeXPGrant(gamification, type, today);

      const finalUpdates = { ...streakUpdates, ...xpUpdates };
      if (Object.keys(finalUpdates).length === 0) return;

      updateGamification(finalUpdates);
      await saveGamification(user.uid, finalUpdates);

      if (xpGained > 0) {
        console.log('[Gamification] +' + xpGained + ' XP for', type);
      }
    },
    [user?.uid, gamification, updateGamification]
  );

  const checkAndResetStreak = useCallback(async () => {
    if (!user?.uid) return;
    const expiry = checkStreakExpiry(gamification);
    if (expiry) {
      updateGamification(expiry);
      await saveGamification(user.uid, expiry);
    }
  }, [user?.uid, gamification, updateGamification]);

  return { recordActivity, checkAndResetStreak };
}
