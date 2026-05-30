---
name: Streak Engine Architecture
description: 3-condition daily checklist, atomic Firestore transactions, timezone-aware dates for Egypt/Sudan.
---

## Single Source of Truth

- gamification.currentStreak is the ONLY streak value displayed in UI.
- userProfile.streak is LEGACY — must never be displayed.
- dailyChecklist lives as field in users/{uid} doc, updated atomically with gamification.

## 3 Daily Conditions

All three must complete in same calendar day (timezone-aware):
1. taskDone — completing any task
2. aiChatDone — valid AI chat message (min 10 chars, must contain letters)
3. cardReviewed — rating at least one flashcard (correct OR wrong)

## Timezone

- Egypt: Africa/Cairo, Sudan: Africa/Khartoum
- getDateForCountry(country) in lib/streakEngine.ts returns YYYY-MM-DD in local tz.

## streakHistory

- streakHistory: string[] of YYYY-MM-DD completed-day strings, trimmed to last 35 days
- 28-day grid in ProfilePage built from getLast28Days(today) + historySet.has(day)
