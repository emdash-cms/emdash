---
"emdash": patch
---

Fixes `emdash seed --validate` accepting unsupported repeater sub-field types. Invalid or missing types and non-object sub-field entries now produce an error identifying the sub-field instead of reporting the seed as valid. These errors also prevent the seed from being applied.
