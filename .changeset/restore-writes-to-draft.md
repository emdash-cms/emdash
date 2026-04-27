---
"emdash": patch
---

Fixes `revision_restore` for collections that support revisions: restore now creates a new draft revision from the source revision's data and updates `draft_revision_id`, leaving the live columns untouched. Previously, restore overwrote the live row directly and left any pending draft unchanged, opposite to the documented contract ("Replaces the current draft..."). The response is also hydrated so the returned `data` reflects the post-restore state.

Behavior is unchanged for collections that do not support revisions.
