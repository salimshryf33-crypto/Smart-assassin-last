---
name: Security Stability Layer
description: Phase 1 security/stability features — rate limiting, PDF validation, RBAC, DB backups.
---

## What was added (all additive — no existing behavior changed)

### New DB tables (created via runStartupMigrations() on startup)
- `rate_limit_buckets` — token bucket state; id = "uid:action"
- `user_roles` — RBAC roles; roles: student/teacher/moderator/admin/super_admin
- `pdf_upload_hashes` — SHA-256 fingerprints for duplicate detection
- `db_backup_log` — backup run history

### New files
- `src/lib/dbMigrations.ts` — idempotent startup table creation
- `src/middleware/rateLimiter.ts` — token bucket per user per action
- `src/lib/pdfValidator.ts` — PDF security checks (magic bytes, %%EOF, malicious patterns, SHA-256 dedup)
- `src/lib/rbac.ts` — role CRUD (grantRole/revokeRole/getUserRoles/hasRole)
- `src/middleware/rbac.ts` — requireRole() / requireAnyRole() middleware
- `src/lib/backupScheduler.ts` — daily pg_dump at 02:00 UTC, 30-day retention
- `scripts/backup-db.sh` — manual backup CLI
- `scripts/restore-db.sh` — restore CLI (requires "RESTORE" confirmation)

### Routes modified
- `POST /api/curriculum/upload` — added rateLimit('pdf_upload') + validatePdf()
- `POST /api/exams/generate` — added rateLimit('exam_generation')

### New admin endpoints
- `POST /api/admin/roles/grant` + `POST /api/admin/roles/revoke`
- `GET /api/admin/roles/:uid` + `GET /api/admin/roles/list/:role`
- `POST /api/admin/rate-limits/reset` + `GET /api/admin/rate-limits/:uid`
- `GET /api/admin/backup/health` + `POST /api/admin/backup/run`

## Rate limit actions and capacities
| action | capacity | refill |
|--------|----------|--------|
| pdf_upload | 10/hour | per hour |
| exam_extraction | 5/hour | per hour |
| ocr_recovery | 15/hour | per hour |
| ai_chat | 60/hour | per hour |
| exam_generation | 5/hour | per hour |
| default | 120/hour | per hour |

## Critical design decisions
**Why:** Rate limiter fails OPEN on DB error — never blocks legitimate users when PG is slow.
**Why:** PDF validator fails BEFORE enqueueing to OCR queue — saves Gemini quota on bad files.
**Why:** RBAC uses existing isAdmin() check as bypass — admins always pass requireRole() unchanged.
**Why:** Backup scheduler uses setTimeout (not cron library) — zero extra dependencies.
