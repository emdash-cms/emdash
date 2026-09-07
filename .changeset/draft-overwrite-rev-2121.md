---
"@emdash-cms/admin": patch
---

Fixes a silent draft-overwrite in the page editor. The editor now echoes the entry's `_rev` token on save and autosave, so the server rejects a save that is based on a stale read with a 409 conflict instead of silently replacing a newer draft revision. Editors who hit a conflict now see a clear error and can reload instead of losing work.
