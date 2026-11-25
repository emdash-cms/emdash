---
"@emdash-cms/plugin-forms": patch
---

Fixes a form edit, pause or delete being undone by a submission that was still being processed when the change was saved. Recording a submission, deleting one and the retention cleanup now adjust only the form's submission counters, so a paused form stays paused and a deleted form stays deleted, and the count stays accurate when several submissions arrive at once. The plugin now requires `emdash` 0.38.0 or later.
