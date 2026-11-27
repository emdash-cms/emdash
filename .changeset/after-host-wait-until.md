---
"emdash": patch
---

Fixes work deferred with `after()` possibly being dropped on Vercel and Netlify once the response is sent. `after()` now hands the task to the host's `waitUntil`: Netlify's request context, Vercel's request context, or `locals.waitUntil` when the site's own middleware sets one. Cloudflare keeps using its own `waitUntil`, and `@astrojs/node` still runs deferred work in the long-lived process.
