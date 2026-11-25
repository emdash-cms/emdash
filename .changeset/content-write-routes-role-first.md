---
"emdash": patch
---

Fixes the single-entry content API answering differently for missing and existing entries when the caller's role can never perform the action. Updating, deleting, locking, publishing, unpublishing, scheduling, restoring or discarding the draft of an entry, restoring a revision, saving a recovery revision, joining an entry's co-editing room, and calling a plugin's editor panel or action now answer `403` to such a caller whether or not the entry exists. Previously a missing entry answered `404` and an existing one `403`. Roles that can perform the action still get `404` for a missing entry.
