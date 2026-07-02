---
"emdash": minor
---

Adds an HTTP API for content references: relation-definition CRUD under `/_emdash/api/relations` (editor-readable, admin-writable) and directed reference edges on content entries under `/_emdash/api/content/:collection/:id/references/:relation/{children,parents}` (ownership-aware). References are stored only in the references table — no collection column. The edge reads are cursor-paginated (`?cursor`/`?limit`, default 50, max 100) and return `nextCursor`; each resolved entry carries the `locale` of the variant returned.
