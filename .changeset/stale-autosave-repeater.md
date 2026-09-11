---
"@emdash-cms/admin": patch
---

Fixes autosave responses from overwriting live edits when they resolve after further typing. Previously, an older autosave payload could replace edits made in repeater sub-fields and other form controls while the request was in flight.
