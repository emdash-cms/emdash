---
"emdash": patch
"@emdash-cms/admin": patch
---

Fixes site transfer imports failing with `TRANSFER_TARGET_NOT_EMPTY` after an import is interrupted while removing seeded scaffold collections. Imports now advance their own scaffold deletion cleanup instead of treating an in-progress deletion as a non-empty target.

New imports are blocked by failed collection deletions. An administrator must first POST `{"collectionId":"<id>"}` to `/_emdash/api/admin/media-usage/collection-deletions/retry`, using the blocker's `id` from transfer capabilities. Active `pending`, `leased`, and `retry` cleanup does not block import. The importer advances cleanup for collections it removes or recreates, yielding while that cleanup is leased or backing off. See the [site transfer guide](https://docs.emdashcms.com/guides/site-transfer/#resolve-failed-collection-cleanup) for recovery steps.
