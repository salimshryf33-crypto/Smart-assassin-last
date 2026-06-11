---
name: Exam Solver Architecture
description: Full exam solving pipeline — IExamSolverStore, autoGrader, weaknessAnalyzer, examGenerator, flashcard bridge, route layout.
---

## Tables (pushed to PostgreSQL)
- `exam_attempts` — one row per student×exam session. status: in_progress|completed|abandoned. scorePct stored as numeric(5,2).
- `exam_answers` — per-question responses; gradingMethod: pending|exact|ai. UNIQUE on id, CASCADE from attempt.
- `weakness_snapshots` — UNIQUE(studentId, country, grade, subject). topicScores: JSONB Record<topic, {correct,total,score}>. score = correct/total (0=worst, 1=best). weakness = 1-score.

## Store separation
- `IExamQuestionStore` (examStore.ts) — exam records + questions. Added `getQuestionById` + `getQuestionsByIds` for solver use.
- `IExamSolverStore` (examSolverStore.ts) — attempts, answers, weakness snapshots. No other file imports @workspace/db for these entities.

## autoGrader.ts
- MCQ/true_false → exact string match (trimmed, lowercase).
- short_answer/essay/calculation → Gemini `gemini-2.5-flash`, returns {isCorrect, feedback} JSON.
- `gradeAttempt(attemptId)` grades all pending answers, updates exam_attempts with scorePct.

## weaknessAnalyzer.ts
- Called fire-and-forget after submit: `updateWeaknessFromAttempt(attemptId, uid)`.
- Uses `examStore.getQuestionsByIds` (no direct DB access).
- Merges new attempt data with existing snapshot (cumulative correct/total per topic).
- `getStudentWeakTopics(uid, country, grade, minTotal=2)` returns sorted by weaknessScore desc.

## examGenerator.ts
- Uses `searchChunks` from curriculumStorage (unchanged) to load up to 12 chunks.
- Throws if no chunks found (requires book to be uploaded first).
- Max 30 questions per call. Saves via `examStore.saveQuestions`.
- Admin caller → ownerId=null, visibility='public'. Regular user → private practice exam.

## Flashcard bridge
- `GET /api/exams/solve/:attemptId/flashcards` returns wrong answers as `{front, back, category, source:'exam_question', examId, questionId}`.
- Frontend saves to Firestore with `source: 'exam_question'` (already in FlashcardSource type).
- No backend Firestore write — bridge is frontend responsibility.

## Route layout
- `/api/exams/solve/*` — examSolver.ts router mounted at /exams/solve
  - POST /start, POST /:id/answer, POST /:id/submit
  - GET /:id, GET /:id/results, GET /:id/flashcards
  - GET /weakness/list, GET /weakness/topics?country=&grade=
- `/api/exams/generate` — examGenerator.ts router mounted at /exams
  - POST /generate

## Architecture rule
All solver/grading/weakness code depends only on IExamQuestionStore + IExamSolverStore.
No business logic imports @workspace/db directly.

**Why:** matches the Phase 1 rule "no business logic may access PostgreSQL directly". Keeps storage swappable.
