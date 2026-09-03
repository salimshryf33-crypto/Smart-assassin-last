---
name: Admin API Preview Routing
description: Admin-only API endpoints need the /api/admin prefix in proxied preview paths.
---

# Admin API Preview Routing

## Rule
For admin-only frontend API clients, prefer `/api/admin/...` paths and mount the backend route beneath the same prefix. Keep older non-admin-prefixed aliases when they are already public interfaces.

**Why:** In the Replit proxied preview, some newly added `/api/...` paths can fall through to the SPA and return 404 even though the local API server route exists. Existing `/api/admin/...` traffic is reliably routed to the API service.

**How to apply:** When adding an admin endpoint, expose it under the admin prefix, protect it with the existing auth and admin middleware, and preserve an existing alias to avoid breaking older clients.