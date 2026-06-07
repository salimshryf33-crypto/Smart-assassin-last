---
name: OCR Resume Architecture
description: How large PDFs survive Gemini API quota windows without restarting from page 1.
---

## The rule
Any change to OCR batch processing MUST preserve all three resume hooks, or quota failures will restart from page 1.

## Three interlocking hooks

### 1. `QuotaExhaustedError` (pdfExtractor.ts)
- Thrown immediately on Gemini HTTP 429 — no retry.
- Carries `lastRenderedPage` (last batch's final PDF page) and `accumulatedTexts` (blobs from successful batches so far).
- The queue catches this and saves whatever was completed.

### 2. `onBatchComplete(lastRenderedPage)` callback (pdfExtractor.ts → curriculumQueue.ts)
- Called after EVERY successful OCR batch via `upsertDocMeta`.
- Persists `lastRenderedPage` to `index.json` on disk after each batch.
- This means if quota hits on batch N+1, the checkpoint from batch N is already durably saved.
- The queue passes this callback as `onBatchComplete` parameter to `extractPdf`.

### 3. `startFromPage` parameter (pdfExtractor.ts)
- Skips stages 1–3 (text-layer extraction) entirely when `startFromPage > 1`.
- Does a lightweight `pdfParse(max=1)` to get total page count for batch loop bounds.
- OCR batch loop starts at `startFromPage` instead of page 1.

## Resume flow
1. User calls `POST /api/curriculum/docs/:docId/resume`
2. Route checks `doc.status === 'partial' || 'error'`, PDF exists on disk.
3. `resumeDoc(docId)` enqueues a job with `resumeFromPage = doc.lastRenderedPage + 1`, `appendMode = true`.
4. `processNext` passes `resumeFromPage` → `extractPdf(startFromPage=resumeFromPage)`.
5. New chunks are appended (not overwritten) via `appendChunks()`.
6. When OCR reaches the last page, status → `done` and final chunk count = existing + new.

## PDF permanent storage
- On upload: `enqueueJob` copies the multer tmp file to `data/pdfs/<docId>.pdf` before deleting the tmp.
- `job.filePath` always points to `data/pdfs/<docId>.pdf` (permanent).
- The `finally` block in `processNext` NEVER deletes `job.filePath`.
- The PDF is only deleted when the doc is explicitly deleted via `DELETE /api/curriculum/docs/:id`.

## Status lifecycle
`queued → processing → ocr_running → done`
                                   ↘ `partial` (quota hit, resumable)
                                   ↘ `error` (other failures)

Both `partial` and `error` are resumable via the resume endpoint.
`partial` docs are searchable for their already-indexed pages.

## Physics book state (as of implementation)
- `id=161f4996-d503-4a85-a220-319ac2960c1d`
- `status=partial`, `lastRenderedPage=92`, `totalPages=215`, `chunkCount=46`
- PDF not in permanent storage (was processed before this refactor) — needs re-upload to resume.
- Use `POST /api/curriculum/reindex/161f4996...` with the PDF to restart from scratch.
- Or place the PDF at `data/pdfs/161f4996...pdf` and then call the resume endpoint.

**Why:** A 215-page Arabic physics book can take 30+ Gemini API batches. The daily free-tier quota runs out mid-book. Without resume, every quota reset meant restarting page 1 and re-charging quota for already-completed pages.

**How to apply:** Any new OCR-backed pipeline (exam OCR, note OCR, etc.) should adopt the same three hooks.
