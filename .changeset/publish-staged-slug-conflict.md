---
"emdash": patch
---

Fixes publishing an entry whose staged slug is already used by another entry in the same locale failing with an opaque database error. Publish now returns a validation error naming the conflicting slug and entry, which the admin can show inline, and leaves the live entry untouched.
