---
"emdash": patch
---

Fix scheduled entries staying hidden after their scheduled time (#1402)

`isVisible()` read `scheduledAt` via `dataStr`, which returned an empty string for the `Date` the loader produced, so entries whose scheduled time had passed never became visible. The visibility check now reads the scheduled time correctly.
