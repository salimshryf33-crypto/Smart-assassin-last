---
name: Question Extractor Token Fix
description: Root cause and fix for 0-question extraction in questionExtractor.ts
---

## Rule
`maxOutputTokens` in `callGemini` (questionExtractor.ts) must be **32768**, not 4096 or 8192.

**Why:** Arabic exam text with fill-in-the-blank dot sequences (e.g. `المعايرة هي ......................`) is extremely token-heavy. At 4096 tokens the JSON response is truncated mid-string → `JSON.parse()` throws → extractor records 0 questions for every chunk even though Gemini extracted real questions.

## compressFillerDots()
Both `buildPrompt` and `buildRetryPrompt` must pre-process chunk text with `compressFillerDots()` which replaces runs of 4+ dots/underscores with short placeholders (`....` / `____`), reducing output token usage significantly.

**How to apply:** Any time `callGemini` is called for question extraction, pass the compressed text not the raw chunk content.

## Diagnosis method
If extraction returns 0 questions despite high Arabic word count and pattern signals:
1. Call Gemini manually with the exact prompt — if it returns valid JSON that's truncated at end, it's the token limit.
2. Check `finishReason` in Gemini response — `MAX_TOKENS` confirms truncation.
3. Check for `429 RESOURCE_EXHAUSTED` if multiple chunks fail silently with 0-char response.
