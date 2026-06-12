---
"emdash": minor
---

Add `RelationRepository`: the application data-access layer over the content-references schema (migration `043`). Manages relation definitions (`_emdash_relations`, row-per-locale) and directed, locale-agnostic reference edges (`_emdash_content_references`). Additive — typed inputs, no API/validation surface yet (Zod schemas and routes arrive in a following slice). Provides `clearReferencesForGroup` as the entry-deletion cleanup primitive; wiring it into the content-delete path is deferred.
