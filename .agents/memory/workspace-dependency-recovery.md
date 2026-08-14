---
name: Workspace Dependency Recovery
description: Replit workspace dependency restoration and workflow restart behavior.
---

When a workspace package declares dependencies but its `node_modules` links are missing, `pnpm add` through the generic package helper may target the workspace root and fail. Restore the existing lockfile with `pnpm install --frozen-lockfile`, then restart affected workflows so long-running processes do not retain stale module paths.

**Why:** Workspace-level dependency links can disappear after import or environment reconstruction even when `package.json` and `pnpm-lock.yaml` are correct; existing Vite processes can also keep resolving removed package paths.

**How to apply:** Prefer the locked workspace install over adding duplicate root dependencies. Verify the affected package build, restart both backend and frontend workflows, and inspect logs for dependency-resolution errors before declaring the preview healthy.