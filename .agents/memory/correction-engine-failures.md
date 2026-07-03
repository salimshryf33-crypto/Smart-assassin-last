---
name: Correction Engine Failure Modes
description: Root cause analysis of incorrect grading — 6 failure modes with exact file/line refs and severity. Diagnosed 2026-07-03.
---

## CRITICAL #1 — Post-topK docId filtering (FIXED 2026-07-03)
Files: evidenceRetriever.ts + curriculumStorage.ts
Fix: Added `docId` to SearchOptions; filter now runs inside searchChunks BEFORE docs.flatMap() chunk loading. Post-hoc rawChunks.filter removed.
Root cause: searchChunks returned global top-6; competing docs could fill all slots; linked doc got 0 chunks after post-hoc filter → isCorrect=false.

## CRITICAL #2 — Stage 2 keyword check uses un-normalized Arabic (NOT YET FIXED)
File: evidenceRetriever.ts:191-212, validateEvidence()
Issue: questionKeywords use .toLowerCase() only — no normalizeArabic(). Chunk content also raw. Diacritics (تشكيل) in OCR text block keyword matches.
Result: chunk flagged 'irrelevant_chunks' → isCorrect=false even when RAG scored it correctly.
Fix: call normalizeArabic() on both questionKeywords and chunk.content in validateEvidence().

## HIGH #3 — Private curriculum docs excluded from correction (NOT YET FIXED)
Files: curriculumStorage.ts:431-432 + evidenceRetriever.ts:100-107
Issue: Correction engine never passes userId → visibility='private' docs silently excluded.
Fix: pass userId or a bypass flag when calling searchChunks from correction context.

## HIGH #4 — Grade band expansion causes cross-grade contamination (KNOWN)
File: curriculumStorage.ts:395-403, resolveGrades()
Issue: resolveGrades('grade10') → {grade10, secondary, grade11, grade12} → wrong-grade docs compete in Phase 1.

## MEDIUM #5 — MCQ separator-less format fails key extraction (KNOWN)
File: deterministicGrader.ts:57-61, extractOptionKey()
Issue: Regex requires separator (). -:) after key. "أ الخلية" → sKey=null → full-string compare → false.

## MEDIUM #6 — Chunk content hard-truncated at 1200 chars (KNOWN)
File: evidenceRetriever.ts:124
Issue: c.content.slice(0, 1200) — evidence after char 1200 never reaches Gemini.
