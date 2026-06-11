---
"emdash": patch
---

Faster cold starts. The first request a fresh server instance handles — after a deploy, or when traffic picks up again after a quiet spell — now runs its startup steps concurrently instead of one at a time, shaving database and storage round trips off that first page load. Especially noticeable on Cloudflare, where new instances spin up frequently.
