---
"emdash": patch
---

Fixes unnecessary session-store reads on public pages for visitors without a session cookie, reducing anonymous render latency on sites using remote session storage such as Cloudflare KV. Respects custom Astro session cookie names when identifying authenticated requests in the main middleware and on public routes.
