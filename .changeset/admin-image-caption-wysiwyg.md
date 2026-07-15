---
"@emdash-cms/admin": patch
---

Editor image figcaption no longer falls back to alt text. The editor showed `caption || alt` below images while the published renderer (Image.astro) shows the caption only — so alt text looked like a caption in the editor that never appeared on the live site. The editor now mirrors the published output: figcaption renders only when a caption is set.
