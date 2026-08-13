---
"emdash": patch
---

Fixes 404 logging for content misses. Templates answer a missing entry with a redirect to /404, which previously left the real missed path unrecorded — the log only ever accumulated one aggregate "/404" row. Misses are now logged under the path the visitor actually requested, and hits on the /404 error page itself are no longer logged.
