---
"emdash": patch
---

The search API now resolves the signed-in session, so `status=draft` queries return draft content for users with the required permission instead of silently falling back to published results. Anonymous requests are unaffected.
