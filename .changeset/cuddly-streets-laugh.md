---
"emdash": patch
"@emdash-cms/admin": patch
"@emdash-cms/cloudflare": patch
---

Fixes the preview path for Cloudflare Stream videos stuck at `0:00` in the Media Library detail panel. The panel uses Stream's hosted player instead of the browser's native HLS/DASH support. Stream preview URLs ending in `/watch` are converted to the embeddable `/iframe` URL. Media providers can supply an optional `playerUrl` for admin video previews; providers without one keep native video playback.

If you use Astro's content security policy, allow the Stream player host in `frame-src` so the preview can load. EmDash's default admin policy already allows HTTPS frames.
