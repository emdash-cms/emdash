---
"emdash": patch
---

Fixes stale runtimes and background cron jobs surviving Node.js `astro dev` restarts, such as after editing `astro.config.mjs`, which could cause `Vite module runner has been closed` errors. The next request now initializes a fresh runtime.
