---
"@emdash-cms/admin": patch
---

Fixes auto-save not detecting plugin block field changes. When editing an existing block's attributes via the Block Kit modal, the change now correctly triggers TipTap's `onUpdate` callback, propagating through to the auto-save dirty detection.
