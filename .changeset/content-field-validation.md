---
"emdash": patch
---

Fixes content create / update silently accepting invalid data: required fields are now enforced, select / multiSelect values must match the configured options, and reference fields must resolve to a real, non-trashed target. Errors surface with a structured `VALIDATION_ERROR` code and a message naming every offending field.
