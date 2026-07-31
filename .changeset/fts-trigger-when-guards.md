---
"emdash": patch
---

Fixes content saves re-tokenizing the full search index even when nothing searchable changed. Metadata-only saves (status changes, scheduling, autosave version bumps) no longer rewrite the FTS index, cutting save CPU and write-ahead-log volume on large documents. Existing deployments get the updated triggers automatically via a migration.
