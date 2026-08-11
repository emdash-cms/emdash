---
"emdash": patch
---

Fixes media-usage tracking rows accumulating without bound. Superseded and abandoned usage generations are now garbage-collected by the periodic maintenance sweep, so the usage table no longer grows with every content save.
