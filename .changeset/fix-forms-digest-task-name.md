---
"@emdash-cms/plugin-forms": patch
---

Fixes form creation and updates failing with "Invalid task name" when the daily digest is enabled.

The plugin now builds digest cron task names with an underscore separator (`digest_<formId>`) instead of a colon, matching the cron task-name rules. Forms with `digestEnabled: true` save successfully and schedule the daily digest; disabling the digest or deleting the form cancels the task as expected.
