---
"emdash": patch
---

Fixes taxonomy-filtered listings sorted by `updated_at` or a custom field reading the whole collection on D1. `published_at` and `created_at` sorts still use the indexed path that stops at `LIMIT`; `updated_at` and field sorts now seek from the term's assignments again.
