---
"emdash": patch
"@emdash-cms/admin": patch
"@emdash-cms/cloudflare": patch
---

Updates Cloudflare Stream video previews in the Media Library detail panel to use the hosted player instead of the browser's native HLS/DASH support. Stream preview URLs ending in `/watch` are converted to the embeddable `/iframe` URL. Media providers can supply an optional `playerUrl` for admin video previews; providers without one keep native video playback.

If you use Astro's content security policy, allow the Stream player host in `frame-src` so the preview can load. EmDash's default admin policy already allows HTTPS frames.
