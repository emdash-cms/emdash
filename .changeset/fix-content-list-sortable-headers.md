---
"emdash": patch
"@emdash-cms/admin": patch
---

Make the admin collection list column headers sortable. `Title`, `Status`, `Locale`, and `Date` are now clickable buttons that toggle direction; the current sort state is exposed via `aria-sort` on the `<th>` so screen readers announce it correctly.

The server's `orderBy` field whitelist now accepts `status`, `locale`, and `name` alongside the existing date fields — unchanged from a security standpoint, the repo still rejects unknown field names to prevent column enumeration.

Callers of `<ContentList>` that don't pass `onSortChange` render the previous static-label headers, so legacy integrations (e.g. the content picker) are unaffected.
