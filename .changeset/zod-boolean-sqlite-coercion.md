---
"emdash": patch
---

Fixes content saves on collections with boolean fields. Boolean fields map to `INTEGER` columns and the repository writes booleans as `0/1`, but never converts them back on read, so a GET → edit → POST round-trip surfaced numbers where the per-collection zod schema expected booleans, and every save was rejected. The boolean field schema now coerces the `0/1` shape to real booleans at the validation boundary; other numbers and strings still fail validation as before.
