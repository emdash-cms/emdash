---
"emdash": patch
---

Fixes `ctx.cron` being undefined during `astro dev` under the `@astrojs/cloudflare` adapter, which silently prevented plugins from scheduling cron tasks and stopped the `cron` hook from ever firing in local dev. The in-process scheduler now keys off Astro's command rather than Vite's, so plugin cron, scheduled publishing, and cleanup run again.
