---
"emdash": patch
---

Fixes Publish in the visual editing toolbar publishing an older version when it is clicked while an inline Portable Text edit is still saving, which left that edit as unpublished changes. Publish now waits until every save on the page has finished.
