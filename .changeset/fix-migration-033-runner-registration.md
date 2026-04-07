---
"emdash": patch
---

Fixes migration 033 (optimize content indexes) not being registered in the static migration runner, so the composite and partial indexes it defines are now actually applied on startup.
