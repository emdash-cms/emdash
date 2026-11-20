---
"emdash": patch
---

Fixes media replacements in the admin not triggering `media:afterUpload`, so upload plugins can process replaced files and send audit-log and webhook notifications.
