---
name: Curriculum Doc Types, OCR, and Extraction Quality
description: docType field, extraction quality validation thresholds, OCR fallback, and extraction metadata
---

## docType Field
`docType?: 'book' | 'note' | 'exam'` is optional on `CurriculumDocument` (storage), `Job` (queue), and `CurriculumDocMeta` (frontend types). Defaults to `'book'` for backward compatibility.

**How to apply:** Pass docType through: routes → enqueueJob → upsertDocMeta (all status transitions: queued/processing/ocr_running/done/error).

## Extraction Quality Validation
Every stage in `pdfExtractor.ts` now validates quality BEFORE exiting. A stage must pass ALL three thresholds or falls through to the next stage / OCR.

| Threshold constant | Value | Purpose |
|--------------------|-------|---------|
| `MIN_AVG_CHARS_PER_PAGE` | 150 | avg extracted chars per page |
| `MIN_TOTAL_CHARS` | 2,000 | absolute minimum regardless of page count |
| `MIN_NON_WS_DENSITY` | 0.20 | non-whitespace fraction of total chars |

**Why:** A scanned PDF may extract page numbers/headers only (~50 chars/page) and pass a naive `pageTexts.length > 1` check, silently bypassing OCR. Quality validation catches this.

**How to apply:** `measureQuality(pages)` returns `ExtractionQuality` with `.passed` bool. Every stage (pagerender, form-feed, virtual-split) checks `.passed` before returning. OCR is attempted when all three text stages fail or produce sparse output.

## OCR Pipeline
- Triggered by `onOcrStart` callback passed to `extractPdf()` from the queue
- Queue sets job/doc status to `'ocr_running'` (new status) when OCR begins
- Uses `gemini-1.5-flash` inline PDF base64, max 20MB
- Page separator: `=== الصفحة N ===`; falls back to virtual-split if no markers

## Extraction Metadata Stored Per Doc
`CurriculumDocument` now stores: `extractionMethod ('text'|'virtual'|'ocr')`, `extractedChars`, `avgCharsPerPage`, `extractedPages`. Written to `index.json` on successful completion. Shown in `CurriculumManager` UI as method badge + chars/page label.

## Status Values
`'queued' | 'processing' | 'ocr_running' | 'done' | 'error'`  — both in `CurriculumDocument` and `JobStatus`.

## Known Legacy Issue
The Physics doc (`14aacefb`) was indexed before quality validation existed: 218 pages, 49.7 chars/page (sparse). Original PDF was deleted after processing. User must re-upload the Physics PDF to trigger OCR reindexing.
