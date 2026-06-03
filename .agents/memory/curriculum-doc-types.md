---
name: Curriculum Doc Types & OCR
description: docType field architecture and Gemini OCR fallback for scanned PDFs
---

## Rule
`docType?: 'book' | 'note' | 'exam'` is optional on `CurriculumDocument` (storage), `Job` (queue), and `CurriculumDocMeta` (frontend API types). Defaults to `'book'` when absent for backward compatibility with pre-existing index.json entries.

**Why:** Curriculum management was expanded to support notes and exam papers in addition to textbooks, each with distinct UI differentiation (color, icon).

**How to apply:** Any new upload endpoint or doc-management UI must accept and pass `docType` through: routes → enqueueJob → upsertDocMeta (all 3 calls: queued/processing/done/error). Frontend uploadCurriculumPdf() includes docType in FormData.

## OCR Stage 5
`pdfExtractor.ts` has a 5-stage extraction pipeline. Stage 5 (Gemini Vision OCR) activates only when Stages 1–4 all produce 0 usable pages (scanned/image-only PDF). Uses `gemini-1.5-flash` inline PDF (base64), limited to 20MB. Page separator: `=== الصفحة N ===`. Falls back to virtual-page split if no page markers returned.

**Why:** Egyptian/Sudanese scanned ministry PDFs are common. Text-layer extraction fails for them silently.

**How to apply:** No extra dependencies needed — uses `process.env.GEMINI_API_KEY` directly via fetch. If key is absent, Stage 5 is skipped and job errors with a clear "image-based PDF" message.
