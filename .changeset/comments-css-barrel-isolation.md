---
"emdash": patch
---

Fixes `Comments`/`CommentForm` CSS being bundled into a shared, render-blocking chunk on every page that imports `PortableText` (or any other component) from `emdash/ui`, even when comments are never rendered on that page.
