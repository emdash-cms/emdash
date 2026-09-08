---
"emdash": patch
---

Fixes `content.schedule()` and content updates so offset dates are stored as canonical UTC ISO 8601 timestamps. Positive and negative offsets now publish at the represented instant instead of several hours late or early.
