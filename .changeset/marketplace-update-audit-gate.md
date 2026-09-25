---
"emdash": patch
---

Fixes marketplace plugin updates installing a version that failed or did not clear the marketplace security audit. Updating to a version whose audit verdict is `fail` or `warn`, whether it is the latest version or one chosen explicitly, is now refused with the same `AUDIT_FAILED` error as installing it, and the installed version stays in place.
