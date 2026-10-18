---
"@emdash-cms/plugin-forms": patch
---

Editors can now view forms and all their submissions instead of seeing "Failed to load forms" or "No forms yet". The webhook URL stays hidden from them, and changing or deleting forms and submissions, and the export, stay admin-only. When a role still cannot read forms, the pages and the Recent Submissions widget now say so, and a write action that returns 403 shows a permission message instead of doing nothing.
