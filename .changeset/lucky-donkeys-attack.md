---
"@emdash-cms/admin": patch
---

Fixes editor changes being silently discarded when the publication date of a published entry is saved. Unsaved changes are now written first, so the entry keeps them and the save indicator no longer reports "Saved" over lost work.
