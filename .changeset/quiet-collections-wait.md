---
"emdash": patch
"@emdash-cms/admin": patch
---

Fixes site transfer imports failing with `TRANSFER_TARGET_NOT_EMPTY` after an import is interrupted while removing seeded scaffold collections. Imports now wait for their own scaffold deletions instead of treating an in-progress deletion as a non-empty target.

New imports are blocked while collection cleanup is unfinished, including cleanup left after a collection disappears from the schema. Check the `collection_deletion_unfinished` blocker's `state` in transfer capabilities, or `detail.state` in the analysis plan. Wait for `pending`, `leased`, or `retry` cleanup to finish. For `failed` cleanup, an administrator must first POST `{"collectionId":"<id>"}` to `/_emdash/api/admin/media-usage/collection-deletions/retry`, using the blocker's `id` from capabilities. The admin now distinguishes failed deletions from active cleanup and includes retry instructions. See the [site transfer guide](https://docs.emdashcms.com/guides/site-transfer/#resolve-unfinished-collection-cleanup) for recovery steps.
