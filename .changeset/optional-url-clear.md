---
"@emdash-cms/admin": patch
---

Fixes optional URL fields so clearing the input saves the value as `null` instead of an empty string, which previously caused the save to be rejected as an invalid URL.
