---
name: Curriculum Ownership & Visibility System
description: Auth middleware, admin roles, visibility gating, bookTitle, dedup, Mode A/B search — all wired into the curriculum pipeline.
---

# Curriculum Ownership & Visibility

## Rules
- `visibility: 'public'`  — curriculum books; visible to all authenticated users.
- `visibility: 'private'` — notes/exams; visible only to the owner (`ownerId === uid`).
- Books are admin-only to upload (`docType === 'book'` requires `isAdmin(req.user!)`).
- Notes/exams are uploaded by any authenticated user; `ownerId = req.user.uid`.
- `ownerId = null` for legacy admin-managed books (no personal owner).

## Auth middleware (`src/middleware/auth.ts`)
- Firebase JWT verified with Node.js built-in `crypto` + Google public-key endpoint — **no firebase-admin package**.
- `FIREBASE_PROJECT_ID = sage-78209` env var (shared).
- Admin resolution: Firebase custom claim `admin: true` OR UID in `ADMIN_UIDS` env var (comma-separated).
- Exports: `requireAuth`, `requireAdmin`, `isAdmin`, `verifyFirebaseToken`, `ADMIN_UIDS`.

## Storage type (`UpsertDocInput`)
- `upsertDocMeta` accepts `UpsertDocInput = Omit<CurriculumDocument, 'visibility'> & { visibility?: ... }`.
- This lets callers that only update status/progress omit `visibility` — it is preserved from the existing record.
- **Why:** many code paths in the queue/resume pipeline call `upsertDocMeta` without ownership context; preserving existing ownership fields prevents accidental data loss.

## Duplicate protection
- On `POST /upload` for `docType === 'book'`, duplicate key = `(country, grade, subject, bookTitle, visibility=public)`.
- Returns HTTP 409 with `existingDocId` hint if duplicate found.

## Search modes
- **Mode A** (default): omit `bookTitle` param — searches all books in the subject.
- **Mode B**: pass `bookTitle` — restricts to one specific book.
- Both modes automatically include caller's own private docs.

## Express 5 typing quirk
- `@types/express-serve-static-core@5.1.1` types `ParamsDictionary` as `{ [key: string]: string | string[] }`.
- **Fix**: helper `const str = (v: string | string[] | undefined): string => Array.isArray(v) ? v[0] ?? '' : v ?? ''` at the top of routes files.
- `req.query` cast: `req.query as Record<string, string>` for simple destructuring.

## Startup migration (`migrateIndex`)
- Called in `src/index.ts` inside `app.listen` callback.
- Adds `visibility` and `bookTitle` defaults to legacy docs (safe no-op if already set).
- Legacy books → `visibility: 'public'`, `bookTitle = filename stem`.

## Frontend (`CurriculumManager.tsx`)
- Fetches `isAdmin` from `GET /api/curriculum/me` on mount; hides 'book' doc type tab for non-admins.
- `bookTitle` field shown when `docType === 'book'`.
- Visibility badge ("خاص") and bookTitle chip shown in doc list.
- `country` state typed as `'' | 'egypt' | 'sudan'` with explicit cast from `studentProfile.country`.
