---
"emdash": patch
---

Fixes `emdash-env.d.ts` not updating when the schema changes during `astro dev` with the Cloudflare adapter. Adding or editing collections and fields now regenerates types on Cloudflare too, not only on Node.
