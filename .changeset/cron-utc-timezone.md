---
"emdash": patch
---

Fixes plugin cron schedules so recurring expressions (`@daily`, `@hourly`, standard cron, etc.) resolve in UTC instead of the host OS timezone. The same schedule now fires at the same instant on Cloudflare Workers and Node self-hosts regardless of the server `TZ` setting.
