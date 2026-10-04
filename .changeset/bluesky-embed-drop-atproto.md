---
"@emdash-cms/plugin-embeds": patch
---

Fixes `astro dev` on the Cloudflare adapter crashing with `exports is not defined` on every page that renders Portable Text while the embeds plugin is installed.

Bluesky posts now render from Bluesky's oEmbed endpoint instead of a server-rendered card, so visitors' browsers load Bluesky's embed script and iframe from `embed.bsky.app`. Sites with a Content Security Policy need to allow that host in `script-src` and `frame-src`; otherwise the post shows as a plain quote. If Bluesky can't be reached while the page renders, the post shows as a link.
