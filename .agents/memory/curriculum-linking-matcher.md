---
name: Curriculum Linking Matcher
description: Key quirks and calibration decisions for curriculumMatcher.ts (Phase 2 linking system).
---

## Architecture

- `examRecord.curriculumDocId` = the curriculum document created when the exam PDF was uploaded. It has `docType: 'exam'`, so it is **always filtered out** by the `d.docType !== 'exam'` guard. Do NOT rely on `isExplicitLink` being true for most exams — it will be false.
- The matcher finds curriculum BOOKS by normalized country+grade+subject match. This is the primary signal.
- A pure metadata match (no keywords, no chapter overlap) scores `40/100 = 40%`.

## Thresholds

| Threshold | Value | Reason |
|---|---|---|
| `AUTO_APPROVE_THRESHOLD` | 90 | High confidence — auto-approve without admin |
| `PENDING_THRESHOLD` | **35** | Must be ≤ 40 so metadata-only matches (40%) reach `pending_review` not `no_match` |

**Why 35 not 50**: A pure metadata match (same country/grade/subject) is already a strong signal in a small curriculum system. 40% confidence should always reach `pending_review`. `no_match` should only mean "zero curriculum docs found for this subject/grade/country".

## Candidate pool strategy

1. `ownDoc`: exam's `curriculumDocId` if it has `docType !== 'exam'` (rare — usually null)
2. `metaDocs`: normalised country/grade/subject match (`normalizeArabic + trim + collapse spaces`)
3. Both combined — ownDoc first if present

## Startup scan

`scanUnlinkedExams()` runs 12 seconds after startup and re-matches:
- Exams with no `curriculum_links` row at all
- Exams with `cl.status = 'no_match'` AND `linked_curriculum_doc_id IS NULL`

Also exposed as `POST /api/curriculum-links/rematch-all` for admin UI.
