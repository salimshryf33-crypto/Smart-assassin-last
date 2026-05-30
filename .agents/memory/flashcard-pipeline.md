---
name: Flashcard Pipeline Architecture
description: How the AI flashcard generation pipeline works — generation triggers, SRS, dedup, daily limits, understanding checks.
---

## Core Design

- Flashcard type extended with optional fields (source, status, easeFactor, interval, repetitions, nextReviewDate, curriculumTag) — all optional for backward compat.
- lib/flashcardEngine.ts is the single source of truth for all flashcard logic.
- Modules strictly separated: AIChat triggers generation but does NOT import from FlashcardsPage.

## Generation Flow

1. AI responds → triggerFlashcardGeneration(aiResponse) fires ASYNC (non-blocking)
2. Calls Gemini with JSON-extraction prompt → returns {flashcards[], understandingCheck?}
3. Filters duplicates (Jaccard similarity >= 0.70 on word sets)
4. Enforces MAX_FLASHCARDS_PER_DAY = 10 (counts AI-generated cards by createdAt date)
5. Saves to Firestore + optimistic UI via addFlashcardLocal
6. Every AI card inherits {country, level, track, subject} from active curriculum context

## Understanding Check Flow

1. Gemini returns understandingCheck: {question, correctAnswer} alongside flashcards
2. Shown as a dismissible panel above the input bar in AIChat
3. Student answers → evaluateUnderstandingAnswer() calls Gemini to evaluate
4. If understood = false: creates a student_mistake flashcard automatically

## SRS Algorithm (SM-2)

- updateCardSRS(card, quality: 0-5) — quality 5 = correct, quality 1 = wrong
- Fields updated: easeFactor, interval, repetitions, status, nextReviewDate, lastReviewed, reviewCount

## Review Prioritization

prioritizeCards() sort order:
1. source === student_mistake always first
2. nextReviewDate <= now (due for review)
3. !lastReviewed (never reviewed)
4. Earlier nextReviewDate first

## Streak Integration

- recordActivity(flashcard) fires on BOTH correct AND wrong card ratings
- Opening page or viewing card does NOT count
