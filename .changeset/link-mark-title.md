---
"emdash": patch
---

Fixes the Portable Text link mark dropping a `title` stored on the link, so `<PortableText>` now renders it as the link's `title` attribute (shown by browsers on hover). Links without a title render as before.
