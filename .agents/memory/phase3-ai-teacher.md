---
name: Phase 3 AI Teacher Intelligence Engine
description: Ephemeral student learning context injected into Sage prompts per-request from existing WeaknessProfile data
---

## Rule
Every AI tutor response is personalised using a temporary StudentLearningContext built from the WeaknessProfile already computed by the orchestrator. The context is NEVER stored permanently.

## Architecture
- `studentContextBuilder.ts` — pure builder; input: WeaknessProfile → output: StudentLearningContext + formatted prompt block
- `aiOrchestrator.ts` Step 1b — calls `buildStudentLearningContext(weakness)` immediately after `analyzeWeakness()`
- `answerEngine.ts` — `AnswerRequest.studentContext?: StudentLearningContext`; appended to all 3 mode prompts (BOOK/EXAM/QUIZ) via `formatStudentContextSection()`

## Context fields
- `weakTopics`: top 5 with score > 0.1, includes `isCritical` (≥0.6) and `mistakeCount`
- `strongTopics`: score ≤ 0.1 with ≥2 reviewed cards (max 3)
- `depthHint`: 'detailed' (critical > 0) | 'concise' (strong across board) | 'standard'
- `hasEnoughData`: gate — if false, `formatStudentContextSection` returns null → no injection

## Safety rules enforced in prompt
1. Answer student's question FIRST — context only guides style, never interrupts
2. "💡 توصية المعلم" section: optional, ≤2 sentences, only when directly relevant to student's question
3. Context block labeled "للمعلم فقط" — model must not expose it to student
4. Never invent weak topics — only from real WeaknessProfile data
5. RAG grounding rules are NOT relaxed by context injection

**Why:** Adding studentContext as optional field to AnswerRequest (vs. separate parameter) keeps the call signature clean and backward-compatible. Setting all fields optional means zero regression when no weakness data exists.
