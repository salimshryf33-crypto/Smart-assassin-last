---
name: RAG Retrieval Architecture
description: Chapter detection, scoring, and retrieval improvements for curriculum search quality.
---

## topK
Raised from 5 to 10 in both `answerEngine.ts` (engines/) and `utils/ai.ts`.

## Chapter Detection (`chunker.ts`)
Two-function design:
- `isChapterHeading(line)` — strict line-start patterns only. Does NOT include numbered-list patterns (1-, 2., 3)) because they cause massive MCQ false positives in exam documents.
- `extractChapterLabel(text)` — scans ALL lines of a chunk. Pass 1: strict line-start. Pass 2: embedded REGEX (`EMBEDDED_CHAPTER_RE`) for OCR output where book-title/page-number prefixes appear on the same line as the heading (e.g. "79 الأحياء - ثالث ثانوي ب الوحدة الأولى...").
- Subject-label pattern (الموجات/الضوء/etc.) requires EITHER standalone word OR colon/dash — prevents prose sentences like "الطاقة هي المقدرة على إنجاز الشغل" from matching.

**Why:** OCR-scanned Sudanese/Egyptian textbooks have page number + book title prepended to every line. Standard line-start patterns miss 100% of chapter headings. Embedded detection recovered الوحدة الأولى/الثانية from biology book (63 chunks: 0%→100% named).

## Startup Relabeling (`curriculumStorage.ts`)
`relabelChapters()` called in `index.ts` after `migrateIndex()`.
- Idempotent full rescan — ignores ALL previously stored chapter labels, re-derives from content only.
- Propagates chapter forward through subsequent chunks.
- **Why fresh rescan matters:** First bad run may write MCQ items ("1) قوة التثاقل...") as chapter labels; if next run trusts stored labels, bad values propagate forever.

## Scoring (`curriculumStorage.ts: searchChunks`)
- Per-token scoring is now CAPPED (boolean max per token, not additive). Each token contributes at most one value — whichever match type is strongest (exact=6, substr=5, partial=2, keyword=4, chapter=12).
- **Why:** Additive scoring (4+5+2+3 per token) gave massive bonus to content-rich early chapters for any multi-token query, creating early-chapter bias.
- Trigram weight raised from ×15 to ×25.
- Full-phrase bonuses (+20 in content, +30 in chapter name) unchanged.

## Filter Threshold
Replaced fixed `score > 4.0` with adaptive: `max(1.0, topScore * 0.15)`.
**Why:** Fixed threshold excluded valid late-chapter chunks that scored moderately when early chapters dominated. Adaptive threshold ensures we always return topK results as long as they're at least 15% as relevant as the best match.

## Validation Results (3 books)
| Book | Chunks | Chapter Detection |
|------|--------|-------------------|
| Exam sheet (46ac) | 18 | 0% — no headings in dotted answer sheet content (correct) |
| Physics/Sudan (aeab) | 33 | 100% (12 unique chapters), 0 MCQ false positives |
| Biology/Sudan (b1f3) | 63 | 100% (2 units), 0 false positives |

Search quality: chapter name tokens now score ×12 per token (vs ×0 when all labeled "عام"), dramatically boosting late-chapter content for topic-specific queries.
