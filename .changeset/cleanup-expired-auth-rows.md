---
"emdash": patch
---

Fixes scheduled cleanup so it deletes expired OAuth access and refresh tokens, OAuth device codes, and OAuth authorization codes. Previously these rows stayed in the database forever.
