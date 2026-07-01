---
"emdash": patch
---

Fixes collection `where` taxonomy filters matching nothing when filtering a non-default locale by its localized term slug. Term slugs now resolve in the active query locale (#1480).
