---
name: Phase 1 Validation Pipeline (Canonical Answer Layer)
description: Architecture and integration points for the exam_canonical_answers pipeline that derives MCQ correct answers via RAG + Gemini.
---

## Rule
All 7 module files live under `artifacts/api-server/src/lib/examValidation/`. They are the only place that writes to `exam_canonical_answers` or backfills `exam_questions.correct_answer`.

**Why:** Sudanese national exam PDFs are question papers only — no inline answer keys. The extraction pipeline (`questionExtractor.ts`) correctly stores `correct_answer = NULL`. This pipeline fills that gap via Hybrid RAG search + Gemini inference.

**How to apply:** Never write to `exam_questions.correct_answer` outside of `canonicalAnswerStore.populateCorrectAnswer()`.

---

## Key constants
- `CONFIDENCE_THRESHOLD = 0.70` — questions below this stay `LOW_EVIDENCE`; `correct_answer` is NOT populated
- `INTER_QUESTION_DELAY_MS = 2000` — 2s gap between Gemini calls to avoid 429s
- `INTER_EXAM_DELAY_MS = 5000` — 5s gap between exams in startup scan
- Startup delay: 15s `setTimeout` in `index.ts` so `syncAndRecoverExams` finishes first

---

## DB table
`public.exam_canonical_answers` — 1 row per question; `validation_status` CHECK constraint: PENDING / VALIDATED / LOW_EVIDENCE / INVALID / READY. Upsert is idempotent via `ON CONFLICT (question_id) DO UPDATE`.

---

## Integration points (all fire-and-forget)
1. `questionExtractor.ts` → fires `runValidationForExam(examId)` after `saveQuestions` + `saveQuestionsToFile`
2. `index.ts` → fires `runStartupValidation()` via `setTimeout(15000)` after server boot
3. `routes/exam.ts` → `POST /records/:examId/validate` (manual trigger, admin)
4. `routes/exam.ts` → `POST /records/:examId/publish` (safety gate — blocks if any MCQ not READY)
5. `routes/exam.ts` → `GET /records/:examId/validation` (status dashboard, admin)

---

## Quota behavior
`DailyQuotaExhaustedError` thrown by `canonicalAnswerDeriver` propagates up through `runValidationForExam` → `runStartupValidation` stops processing remaining exams cleanly. Free Gemini tier = 20 req/day; resets UTC midnight. Pipeline resumes automatically on next server restart.

---

## Observed behavior (first run)
- 4 questions READY (confidence=1.0), correct_answer written to exam_questions
- 4 questions LOW_EVIDENCE (confidence=0.0 or 0.5) — curriculum doesn't contain those facts
- Gemini correctly returns "لا يمكن تحديد إجابة" when evidence is absent — canonicalAnswerDeriver discards this (not a valid option string) and marks LOW_EVIDENCE
- Daily quota hit after ~8 questions on free tier; clean shutdown

---

## Backward compatibility
`populateCorrectAnswer()` SQL guard: `AND (correct_answer IS NULL OR correct_answer = '')` — never overwrites existing values.
