---
"emdash": patch
---

Fixes a rare case where a redirect that took too long to create could still be added after a newer redirect change had started, once the redirect write lock had been recreated. Such a redirect is now rejected.
