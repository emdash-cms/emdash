---
"@emdash-cms/admin": patch
---

Fix media library admin page and the media picker modal (used by the rich text editor and image fields when embedding media into content) to support libraries larger than 50 items by wiring up cursor-based infinite scroll (mirrors the content list fix from #135)
