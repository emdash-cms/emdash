---
"emdash": patch
"@emdash-cms/admin": patch
---

Fixes a scheduled entry that publishing refuses staying overdue forever. When the scheduler's publish fails with a validation error or a slug conflict, the entry is now unscheduled and the dashboard lists it with the error message, as it already does when a plugin rejects a scheduled publish. Before, the error went only to the server log, the scheduler retried it on every run, and the calendar said scheduled publishing might not be running.

`ScheduledPolicyRejection.pluginId` is now optional, and the record gains an optional `code`: a record written for a refused publish has no `pluginId` and carries the publish error's `code` instead. Code that reads `emdash:scheduled-policy-rejection:*` records, or narrows with `isScheduledPolicyRejection`, should handle a missing `pluginId`.
