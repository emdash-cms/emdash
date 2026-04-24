---
"emdash": patch
---

Fixes text alignment applied in the admin editor (center, right, justify) not appearing on the rendered site. Alignment is now preserved through the ProseMirror ↔ Portable Text round-trip and rendered as `text-align` on paragraph, heading, and blockquote blocks.
