---
"emdash": patch
---

Fixes unnecessary session-store reads on public pages for visitors without a session cookie, reducing anonymous render latency on sites using remote session storage such as Cloudflare KV.
