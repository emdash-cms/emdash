---
"@emdash-cms/admin": patch
"emdash": patch
---

Updates the content editor's Publish section so authors can distinguish the live version from draft changes and choose immediate or scheduled publishing from one contextual action menu.

Publishing dates and schedules display in the browser's local time zone while stored timestamp values remain unchanged.

Schedule and unschedule responses now return the current revision token so subsequent editor saves retain optimistic-concurrency protection.
