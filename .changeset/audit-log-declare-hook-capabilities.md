---
"@emdash-cms/plugin-audit-log": patch
---

Fixes create/update and media-upload events missing from the audit log. The plugin now declares the `content:write` and `media:read` capabilities its `content:beforeSave` and `media:afterUpload` hooks require — previously the hook pipeline silently skipped both hooks, so only deletes were recorded.
