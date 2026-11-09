---
"emdash": patch
"@emdash-cms/admin": patch
---

Fixes scheduled publications refused by validation errors or slug conflicts repeatedly retrying without telling editors why. Refused entries are now unscheduled with their draft changes preserved, and the dashboard shows the reason so editors can correct the entry and schedule it again. This applies to all publish-time validation refusals, including relation-limit errors. Temporary publishing errors remain scheduled for retry.
