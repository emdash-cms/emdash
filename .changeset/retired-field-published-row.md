---
"emdash": patch
---

Fix saving a draft when retired fields remain only in the published content row. A full read-then-write update no longer fails validation for keys the entry already stores in its live data but that are absent from the current draft revision. Genuinely never-stored unknown keys are still rejected.
