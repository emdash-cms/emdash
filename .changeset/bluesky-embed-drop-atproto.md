---
"@emdash-cms/plugin-embeds": patch
---

Fixes the Bluesky embed block still crashing `astro dev` under Astro 6/7 + Cloudflare: `@astro-community/astro-embed-bluesky` depends on `@atproto/api`, whose CommonJS build (transitively `multiformats`) hit the same workerd `require`/`exports`-global crash as the original `astro-embed` umbrella package. Bluesky posts now render via Bluesky's own oEmbed endpoint (`embed.bsky.app`) instead, with no dependency on `@atproto/api`.
