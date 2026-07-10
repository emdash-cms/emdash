---
"emdash": minor
---

MCP `content_create` and `content_update` now accept a `taxonomies` field
(`{ [taxonomyName]: [termSlug, ...] }`) that assigns taxonomy terms in the
same transaction as the content write. Term slugs are resolved in the entry's
locale via the same code path as the `/terms/{taxonomy}` REST route, so the
two entry points can't drift. Also exposed on the REST `POST` and `PUT`
content endpoints for parity. Fixes #953.
