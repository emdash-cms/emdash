---
"emdash": patch
---

Fixes publication workflows so callers can pass the approved `_rev` to publish, unpublish, or discard a draft and receive a `CONFLICT` response when the entry changed. Calls that omit `_rev` keep the existing behavior.
