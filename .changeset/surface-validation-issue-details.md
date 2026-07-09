---
"@emdash-cms/admin": patch
---

Fixes validation errors in the admin showing only a generic "Invalid request data" message. The per-field details (e.g. "name: Too big: expected string to have <=63 characters") are now included, so users can see what to correct.
