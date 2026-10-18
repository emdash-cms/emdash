---
"@emdash-cms/plugin-embeds": patch
---

Fixes `astro dev` on the Cloudflare adapter crashing with `exports is not defined` on every page that renders Portable Text while the embeds plugin is installed.

Bluesky posts now use Bluesky's own embed instead of a server-rendered card without client-side JavaScript. Visitors' browsers load Bluesky's embed script and iframe from `embed.bsky.app`, and the `--bluesky-*` CSS custom properties that styled the old card no longer have any effect. Sites with a Content Security Policy need to allow `embed.bsky.app` in `script-src` and `frame-src`; otherwise the post shows as a plain quote. If Bluesky can't be reached while the page renders, the post shows as a link.
