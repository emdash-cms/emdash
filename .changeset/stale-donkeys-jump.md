---
"@emdash-cms/plugin-embeds": patch
---

Fixes `astro dev` crashing with "exports is not defined" under Astro 6/7 + Cloudflare (`@astrojs/cloudflare`) when `@emdash-cms/plugin-embeds` is installed. Embed components now import directly from their individual `@astro-community/astro-embed-*` packages instead of the `astro-embed` umbrella package, which pulled in `astro-auto-import` and crashed the Cloudflare dev runner.
