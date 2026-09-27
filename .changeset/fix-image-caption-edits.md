---
"@emdash-cms/admin": patch
"emdash": patch
---

Fixes rich text image settings so caption, alt text, tooltip, size, and alignment edits persist when authors click back into the post. Captions and tooltip titles also round-trip independently, so clearing a caption no longer restores it from the tooltip text.
