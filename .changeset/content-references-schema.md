---
"emdash": patch
---

Add content-reference database schema: `_emdash_relations` (relationship-type definitions, row-per-locale) and `_emdash_content_references` (directed, locale-agnostic edges between content entries linked by `translation_group`). Additive, forward-only migration `043`; no existing tables change. Groundwork for reference fields — no field type, API, or admin UI yet.
