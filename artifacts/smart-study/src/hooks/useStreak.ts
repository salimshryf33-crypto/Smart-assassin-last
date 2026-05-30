import { useCallback } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useAppStore } from '../store/useAppStore';
import {
  getDateForCountry,
  isValidAIChatMessage,
  updateChecklistFlag,
  atomicCompleteDay,
  checkStreakExpiryForCountry,
} from '../lib/streakEngine';
import { computeXPGrant, saveGamification } from '../lib/gamification';
import type { ActivityType } from '../lib/gamification';

export function useStreak() {
  const { user } = useAuth();
  const gamification = useAppStore((s) => s.gamification);
  const updateGamification = useAppStore((s) => s.updateGamification);
  const studentProfile = useAppStore((s) => s.studentProfile);
  const dailyChecklist = useAppStore((s) => s.dailyChecklist);
  const updateDailyChecklist = useAppStore((s) => s.updateDailyChecklist);

  const getToday = useCallback(() => {
    return getDateForCountry(studentProfile?.country ?? 'egypt');
  }, [studentProfile?.country]);

  const checkAllMet = useCallback(
    (cl: typeof dailyChecklist) => cl.taskDone && cl.aiChatDone && cl.cardReviewed,
    []
  );

  const triggerCompletion = useCallback(
    async (today: string) => {
      if (!user?.uid) return;
      if (dailyChecklist.dailyCompleted && dailyChecklist.date === today) return;

      const result = await atomicCompleteDay(user.uid, today);
      if (result.streakIncremented) {
        updateGamification({
          currentStreak: result.newStreak,
          longestStreak: result.newLongest,
          lastStreakDate: today,
          lastActiveTimestamp: Date.now(),
        });
        updateDailyChecklist({ dailyCompleted: true, date: today });
      }
    },
    [user?.uid, dailyChecklist, updateGamification, updateDailyChecklist]
  );

  const recordActivity = useCallback(
    async (
      type: ActivityType,
      options?: { taskId?: string; messageText?: string }
    ) => {
      if (!user?.uid) return;

      const today = getToday();

      // Grant XP for any activity regardless of checklist state
      const { xpGained, updates: xpUpdates } = computeXPGrant(gamification, type, today);
      if (xpGained > 0) {
        updateGamification(xpUpdates);
        saveGamification(user.uid, xpUpdates).catch(console.error);
      }

      // focus_session does not contribute to daily checklist
      if (type === 'focus_session') return;

      // If today's checklist is already fully completed — no further action needed
      if (dailyChecklist.dailyCompleted && dailyChecklist.date === today) return;

      // Determine which checklist flag to set
      let flag: 'taskDone' | 'aiChatDone' | 'cardReviewed' | null = null;

      if (type === 'task') {
        if (!options?.taskId) return;
        // If taskDone already set for today — skip
        if (dailyChecklist.taskDone && dailyChecklist.date === today) return;
        flag = 'taskDone';
      } else if (type === 'ai_chat') {
        const text = options?.messageText ?? '';
        if (!isValidAIChatMessage(text)) {
          console.log('[StreakEngine] AI chat rejected: invalid message (too short or spam)');
          return;
        }
        if (dailyChecklist.aiChatDone && dailyChecklist.date === today) return;
        flag = 'aiChatDone';
      } else if (type === 'flashcard') {
        if (dailyChecklist.cardReviewed && dailyChecklist.date === today) return;
        flag = 'cardReviewed';
      }

      if (!flag) return;

      try {
        const updated = await updateChecklistFlag(user.uid, today, flag);
        updateDailyChecklist(updated);

        if (checkAllMet(updated)) {
          await triggerCompletion(today);
        }
      } catch (err) {
        console.error('[StreakEngine] Failed to update checklist flag:', err);
        // Safe: UI remains functional, streak preserved
      }
    },
    [
      user?.uid,
      gamification,
      dailyChecklist,
      getToday,
      updateGamification,
      updateDailyChecklist,
      checkAllMet,
      triggerCompletion,
    ]
  );

  const checkAndResetStreak = useCallback(async () => {
    if (!user?.uid) return;
    const expiry = checkStreakExpiryForCountry(gamification, studentProfile?.country ?? 'egypt');
    if (expiry) {
      updateGamification(expiry);
      await saveGamification(user.uid, expiry).catch(console.error);
    }
  }, [user?.uid, gamification, studentProfile?.country, updateGamification]);

  return { recordActivity, checkAndResetStreak };
}
