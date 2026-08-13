---
"@emdash-cms/admin": patch
"@emdash-cms/cloudflare": patch
"emdash": patch
---

Fixes media previews for streaming providers such as Cloudflare Stream. Video from these providers now shows its poster thumbnail in the media library grid and list, plays in the detail panel instead of stalling at 0:00, and reports the file size the provider supplies. Also exports `Media` from `emdash/ui`, so frontends can render provider-backed video and audio that `Image` cannot.
