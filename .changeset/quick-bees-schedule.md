---
"emdash": patch
---

Fixes scheduled maintenance stopping after the initialization request in Cloudflare `astro dev`. EmDash now invokes the project's Cloudflare `scheduled()` handler from the long-lived dev server, keeping plugin cron jobs, scheduled publishing, cleanup, and declared plugin storage index creation running between requests.
