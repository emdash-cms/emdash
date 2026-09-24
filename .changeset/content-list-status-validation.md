---
"emdash": patch
---

Fixes `GET /_emdash/api/content/{collection}?status=all` returning an empty list. `status=all` now lists entries of every status, the same as omitting `status`. The endpoint, `EmDashClient.list()`, and `emdash content list --status` now reject any other value outside `draft`, `published`, `scheduled`, `archived`, `pending`, `private`, and `future` with a `400 VALIDATION_ERROR` instead of silently returning no items. Clients that sent a mistyped or unsupported status should send one of these values or omit `status`.
