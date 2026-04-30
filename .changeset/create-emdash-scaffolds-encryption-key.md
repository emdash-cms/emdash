---
"create-emdash": minor
---

Scaffolds a fresh `EMDASH_ENCRYPTION_KEY` into `.dev.vars` (Cloudflare
templates) or `.env` (Node templates) on project creation, and ensures the
file is gitignored. Idempotent — won't overwrite an existing key on re-runs.
