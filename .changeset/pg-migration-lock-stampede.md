---
"emdash": patch
"@emdash-cms/cloudflare": patch
---

Fixes a database stampede on Postgres when a pending migration fails at runtime: requests no longer pile up waiting on the migration lock, failed migrations are retried with a backoff instead of on every request, and failed attempts no longer leak idle database connections.
