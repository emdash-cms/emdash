---
"emdash": patch
"@emdash-cms/cloudflare": patch
---

Reduces the database round trips on the first request to a fresh D1 Worker isolate by one: the migration check now rides in the runtime's startup batch instead of running as a separate query.
