---
name: Exam Recovery & Gemini Quota
description: Quota limits per model, which models work on this API key, isDailyQuota detection logic, and JSON snapshot persistence.
---

## Gemini model quotas on this API key

| Model | Free tier RPD | Status |
|-------|--------------|--------|
| `gemini-2.5-flash` | ~500 RPD | ✅ Works |
| `gemini-2.0-flash` | **0 RPD** | ❌ Blocked (limit:0 in quota error) |
| `gemini-1.5-flash` | unknown | ❌ 404 on v1beta (wrong name — use `gemini-1.5-flash-latest`) |

**Always use `gemini-2.5-flash` for questionExtractor.ts** — it is the only model with a non-zero quota on this key.

## Daily quota exhaustion pattern

- Quota resets at **00:00 UTC** each day.
- A full 3-exam extraction needs ~15-20 Gemini calls (3-5 per exam × 3 exams).
- Chemistry (~5 calls) + Biology 2022 failures from 503 spikes (~10 calls) can exhaust today's budget.
- When quota exhausted mid-batch, remaining exams stay `pending` and are retried on next startup.

## isDailyQuota detection rule

The function checks the 429 body for daily-quota indicators:
```typescript
str.includes('PerDay') || str.includes('per_day') || str.includes('Daily') || str.includes('daily')
```
**Why:** Plain `RESOURCE_EXHAUSTED` can be either daily quota OR per-minute rate limit. The Gemini error body always contains `GenerateRequestsPerDayPerProjectPerModel-FreeTier` or similar when it's a genuine daily limit. Per-minute rate limits should retry with backoff (15s/30s/60s) not stop immediately.

## JSON snapshot persistence

After every successful extraction, questions are saved to:
`artifacts/data/curriculum/questions/{examId}.json`

On startup, `syncAndRecoverExams` checks JSON first — if snapshot exists, restores from file (zero Gemini calls). This protects against DB resets and avoids re-consuming quota on server restarts.

## recover-exams endpoint fix

`POST /api/admin/recover-exams` now `break`s the loop on `DailyQuotaExhaustedError` instead of continuing to attempt all pending exams after quota runs out. Delay between exams is 45s.
