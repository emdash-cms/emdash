---
"emdash": patch
---

Fixes scheduled cleanup so it deletes expired OAuth access and refresh tokens, OAuth authorization codes, and OAuth device codes. Previously these rows stayed in the database forever. Device codes are deleted one hour after they expire, so a client still polling a just-expired device login gets `expired_token` rather than `invalid_grant`. A new migration indexes device codes by expiry for this cleanup.
