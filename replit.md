# Sage — مساعدك الدراسي الذكي

An Arabic-language AI-powered smart study platform for Sudanese grade-12 students. Features curriculum OCR, RAG-based AI chat, exam solving with auto-grading, flashcards, streak tracking, and a weakness dashboard.

## Run & Operate

- **Frontend** (port 24111): `pnpm --filter @workspace/smart-study run dev`
- **API Server** (port 8080): `pnpm --filter @workspace/api-server run dev`
- Full install: `pnpm install` (run once after cloning or after dependency changes)
- Typecheck: `pnpm run typecheck`
- Build all: `pnpm run build`
- DB schema push (dev only): `pnpm --filter @workspace/db run push`
- Regenerate API hooks from OpenAPI spec: `pnpm --filter @workspace/api-spec run codegen`

## Workflows

- `artifacts/api-server: API Server` — Express backend on port 8080
- `artifacts/smart-study: web` — React/Vite frontend on port 24111

## Required Secrets

| Secret | Status | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | ❌ MISSING | AI chat, OCR, exam grading, flashcards, embeddings |
| `FIREBASE_ADMIN_SERVICE_ACCOUNT` | ❌ MISSING | Admin custom claim management (regular auth still works) |
| `REDIS_URL` | ⚠️ Optional | Cache persistence; falls back to in-memory without it |
| `REPLIT_OBJECT_STORAGE_BUCKET_ID` | ⚠️ Optional | Object storage for PDFs |

Already set (via `.replit` userenv or Replit Secrets):
- `VITE_FIREBASE_*` — all Firebase client config vars ✅
- `FIREBASE_PROJECT_ID`, `ADMIN_UIDS` ✅
- `DATABASE_URL` / `PG*` — Replit managed PostgreSQL ✅
- `SESSION_SECRET` ✅

## Stack

- pnpm workspaces monorepo, Node.js 20, TypeScript 5.9
- **API**: Express 5, esbuild bundle, pino logger
- **Frontend**: React + Vite, Firebase client auth, Wouter routing, Framer Motion, Recharts
- **DB**: Replit managed PostgreSQL + Drizzle ORM (schema in `lib/db/src/schema/`)
- **AI**: Google Gemini (via `@google/genai`) for OCR, RAG chat, grading, embeddings
- **Auth**: Firebase client SDK (frontend) + manual RS256 verifier (backend)
- **Cache**: ioredis with in-memory TTL fallback

## Where things live

- `artifacts/api-server/src/` — Express backend source
  - `routes/` — all API routes (curriculum, gemini, exam, admin, health…)
  - `middleware/` — auth, RBAC, rate limiter, security headers
  - `lib/` — core logic: OCR pipeline, RAG retrieval, exam solver, flashcard engine, streak engine
- `artifacts/smart-study/src/` — React frontend
- `artifacts/api-server/data/curriculum/` — `index.json` (curriculum manifest) + `docs/` chunks
- `artifacts/api-server/data/pdfs/` — uploaded PDF files (5 PDFs present)
- `lib/db/src/schema/` — Drizzle ORM schema (source of truth for all tables)
- `lib/api-spec/openapi.yaml` — OpenAPI spec (source of truth for API contracts)

## Curriculum State (on import)

6 documents loaded, all `status: done`:
- Biology grade 12 textbook — 252 pages, 63 chunks ✅
- Physics grade 12 textbook — 215 pages, 33 chunks (only 25 pages OCR'd) ⚠️
- Chemistry grade 12 textbook — 409 pages, 101 chunks ✅
- Chemistry exam 2022 — 48 questions extracted ✅
- Biology exam 2024 — 50 questions extracted ✅
- Biology exam 2022 — 87 questions extracted ✅

## Architecture Decisions

- **Startup recovery chain**: `runStartupMigrations` → `restoreCurriculumFromDB` → `migrateIndex` → `relabelChapters` → `scanUnlinkedExams`. Always runs at boot; safe no-op if already up to date.
- **Disk + DB dual write**: PDFs and curriculum chunks are written to both local disk and PostgreSQL so they survive container restarts.
- **Firebase Admin is lazy**: `FIREBASE_ADMIN_SERVICE_ACCOUNT` is only needed when setting custom claims (admin role grant). Token verification uses a manual RS256 verifier and does NOT require the service account.
- **Redis is optional**: All cache routes fall back to an in-memory TTL store if `REDIS_URL` is absent. Cache is lost on restart in that mode.
- **Gemini quota**: Free tier = 20 requests/day; resets UTC midnight. Quota exhaustion stops retries gracefully (`DailyQuotaExhaustedError`).

## Gotchas

- `pnpm install` must be run before any workflow starts — node_modules are not committed.
- All SQL must use `public.table` (never bare table names) — Neon/PG role has empty `search_path`.
- The physics textbook (`aeab0878`) is marked `done` but only 25/215 pages were OCR'd. Change its status to `partial` from the admin dashboard to resume extraction (requires `GEMINI_API_KEY`).
- `pg_dump` is used by the backup scheduler — requires `postgresql-16` module in `.replit`.
- Port mapping: API runs on 8080 internally (mapped to external port 80); frontend on 24111 (mapped to external 3000).

## User Preferences

_Populate as you build — explicit user instructions worth remembering across sessions._
