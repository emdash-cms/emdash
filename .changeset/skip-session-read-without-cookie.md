---
"emdash": patch
---

Fixes Astro session lookups firing on every anonymous public SSR request (#733). The middleware now skips `context.session.get("user")` when no `astro-session` cookie is present, which on Cloudflare Workers (where the Astro session backend is KV) was turning normal anonymous traffic into a flood of KV read misses. Logged-in editors, admin routes, edit/preview flows, and any request that actually carries the session cookie continue to read the session as before.
