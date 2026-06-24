---
name: Redis Cache Layer
description: ioredis caching with automatic in-memory fallback; never a hard dependency.
---

## Rule
Redis is optional. If REDIS_URL is not set or Redis crashes, the system silently falls back to an in-process TTL Map. Application never errors due to cache failure.

**Why:** Fail-safe is a hard requirement. Cache must never break production.

## Architecture
- `services/redisService.ts` — Redis client (ioredis) + MemoryBackend fallback. Exposes: cacheGet/cacheSet/cacheDel/cacheFlushAll/cacheDelByPattern/getRedisInfo.
- `services/cacheService.ts` — Typed wrapper: get<T>/set<T>/del/flushAll/invalidatePattern + TTL constants + metrics counters.
- `middlewares/cacheMiddleware.ts` — Express middleware for GET routes: patches res.json to store response; returns early on HIT.

## TTL constants
- CHAT: 86400s (24h) — sage:chat:{sha256(model+body)[0:16]}
- SEARCH: 86400s (24h) — sage:search:{uid}:{country}:{grade}:{subject}:{sha256(query+topK+bookTitle)[0:16]}
- DASHBOARD/WEAKNESS: 3600s (1h) — sage:weakness:{uid}:list | sage:weakness:{uid}:topics:{country}:{grade}

## What IS cached
- POST /api/gemini/generate (chat) — inline logic in gemini.ts
- GET /api/curriculum/search — inline logic in curriculum.ts
- GET /api/exams/solve/weakness/list — inline logic in examSolver.ts
- GET /api/exams/solve/weakness/topics — inline logic in examSolver.ts

## What is NEVER cached
- Exam submissions, answers, grading, OCR jobs, question extraction, auth — zero cache imports in those files.

## Admin endpoints
- GET /api/admin/cache-health — backend/connected/keyCount/metrics (read-only, admin-only)
- POST /api/admin/cache/flush — flush entire cache (admin-only)

## X-Cache headers
All cached routes respond with X-Cache: HIT or X-Cache: MISS.
Error responses (non-ok upstream, catch blocks) do NOT cache and do NOT set X-Cache.

## How to apply
- To add caching to a new GET route: use `cacheMiddleware(keyFn, ttl)` from middlewares/cacheMiddleware.ts.
- To add caching to a POST route: inline get/set calls from cacheService.ts.
- Never cache write operations, auth, or anything that mutates state.
- To invalidate on write: call `cache.invalidatePattern('sage:search:')` or `cache.del(specificKey)`.
