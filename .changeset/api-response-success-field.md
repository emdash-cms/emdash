---
"emdash": patch
---

Fixes API responses to include the `success` field documented in the REST API reference: successful responses are now `{ success: true, data }` and error responses `{ success: false, error }`. The existing `data` and `error` fields are unchanged, so existing clients keep working.
