---
"emdash": patch
"@emdash-cms/admin": patch
---

Fixes site transfer imports failing with `TRANSFER_TARGET_NOT_EMPTY` after an interruption while removing starter collections created during setup. Resuming the import now continues that cleanup instead of treating the collection as existing content.

**Settings → Transfer** now identifies collections whose deletion failed and explains how to retry them before importing. Deletions that are still in progress do not block a new import; the importer advances their cleanup.

#### What should I do?

If your import was interrupted, reopen **Settings → Transfer** to continue it, or run `emdash site import resume <operation-id>`. If the import or a collection deletion failed, follow the guide's [retry and recovery steps](https://docs.emdashcms.com/guides/site-transfer/#resolve-failed-collection-cleanup) before starting another import.
