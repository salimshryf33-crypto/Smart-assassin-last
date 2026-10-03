---
name: Managed Artifact Workflows
description: Avoid duplicate local-port listeners when starting this project's web and API artifacts.
---

## Rule
Start the registered web and API services through their Replit-managed artifact workflow names. Do not also start duplicate root workflows on the same ports.

**Why:** Replit starts artifact services on their configured ports; duplicate root workflows can fail with `EADDRINUSE` even while the artifact preview is already serving.

**How to apply:** When changing the project run button or restarting services, use the exact workflow names shown for the registered artifacts and verify their ports before starting another process.