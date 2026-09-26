---
"emdash": patch
---

Fixes scheduled maintenance stopping after the initialization request in Cloudflare `astro dev`. EmDash now drives its own maintenance through a dev-only workerd route from the long-lived dev server, keeping plugin cron jobs, scheduled publishing, cleanup, and declared plugin storage index creation running between requests without invoking application-wide scheduled jobs.
