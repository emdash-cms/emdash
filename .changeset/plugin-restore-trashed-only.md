---
"emdash": patch
---

Fixes `ctx.content.restore()` in plugins so restoring an entry that is not in the trash fails with `NOT_FOUND`, the same error a missing entry gets, instead of `CONFLICT`. Restoring trashed entries is unchanged.
