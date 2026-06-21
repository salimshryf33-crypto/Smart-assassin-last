---
name: Extraction Quality Engine
description: 8-phase pipeline for exam question extraction quality — files, data flow, key decisions.
---

## What it is
A multi-pass extraction system that takes OCR'd exam PDF chunks and produces clean, deduplicated, scored question sets via Gemini.

## The 8 Phases (in execution order)

| Phase | Where | What |
|-------|-------|------|
| 7 — Cache | extractionCache.ts | SHA-256 chunk fingerprint → skip Gemini if already extracted |
| 1+2 — Coverage | coverageAnalyzer.ts | `analyzeChunkCoverage()`: if LOW_EXTRACTION_COVERAGE → trigger Pass 2 (aggressive prompt) |
| 3 — Recovery | questionExtractor.ts | 3rd targeted pass on chunks with 0 questions but ≥1 pattern signal |
| 4 — Normalize | questionNormalizer.ts | Fix OCR artifacts (stray dots, kashida, zero-width), merge split lines |
| 5 — Dedup | questionNormalizer.ts | `deduplicateEnhanced()`: exact match first, then Jaccard (threshold 0.85) |
| 1 — Whole-exam | coverageAnalyzer.ts | `analyzeCoverage()` over all chunk diags → LOW_EXTRACTION_COVERAGE flag |
| 6 — Score | coverageAnalyzer.ts | `computeExtractionScore()`: 0-100 weighted score + letter grade |
| 8 — Report | admin.ts | GET /api/admin/extraction-report → full JSON quality report per exam |

## Key files
- `lib/questionExtractor.ts` — orchestrator; also exports `DailyQuotaExhaustedError`
- `lib/coverageAnalyzer.ts` — `analyzeChunkCoverage`, `analyzeCoverage`, `computeExtractionScore`
- `lib/questionNormalizer.ts` — `normalizeAll`, `deduplicateEnhanced`
- `lib/extractionCache.ts` — `getCachedExtraction`, `setCachedExtraction`, `getExtractionCacheStats`, `clearExtractionCache`
- `routes/admin.ts` — Phase 8 report + POST /api/admin/cache/clear

## ocrDiagnostics JSONB shape (stored in exam_records)
```json
{
  "ocrScore": { "score": 80, "arabicWords": 1200, "uniqueWordRatio": 0.42 },
  "coverage": { "flag": "OK", "coverageRatio": 0.88, "diagnosis": "..." },
  "extractionScore": { "total": 92, "grade": "A", "breakdown": {...} },
  "normalization": { "rawExtracted": 120, "afterNorm": 118, "exactRemoved": 4, "nearRemoved": 2, "finalCount": 114 },
  "cache": { "size": 12, "hits": 3, "maxSize": 500 },
  "chunkCount": 8, "chunksAttempted": 8,
  "chunks": [{ "chunkIndex": 0, "chars": 2000, "arabicWords": 150, "questionPatterns": 5, "extracted": 12, "retried": false, "cached": false, "coverageFlag": "OK", "pass": 1 }]
}
```

## Why 3 passes
- Pass 1: Standard conservative extraction (avoids false positives)
- Pass 2: Aggressive extraction when Pass 1 underperforms on chunks with OCR signals
- Pass 3: Recovery pass only for completely failed chunks with credible signals — prevents wasted Gemini calls on actually-empty chunks

**Why:** OCR Arabic exams have highly variable text quality. A single prompt strategy missed 20-30% of questions on noisy scans. The coverage-gated approach adds Gemini calls only where evidence suggests questions were missed.
