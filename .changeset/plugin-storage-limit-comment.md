---
"emdash": patch
---

Fixes the `QueryOptions.limit` type comment to match the documented and enforced maximum of 100 rows. Plugin storage queries were already clamped at 100; the previous comment incorrectly stated 1000.
