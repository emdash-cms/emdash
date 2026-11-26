---
"@emdash-cms/plugin-forms": patch
---

Fixes form changes and submission counts overwriting each other. Recording a submission, deleting one and the retention cleanup now write only the form's submission counters, so a form paused, edited or deleted while a submission is being processed stays that way. Saving a form now writes only the fields it edits, so it no longer resets the submission count, and it returns not found instead of recreating a form that was deleted while the save was in progress. The submission count is recalculated from the stored submissions each time, which also corrects a count that was already wrong. The plugin now requires `emdash` 0.38.0 or later.
