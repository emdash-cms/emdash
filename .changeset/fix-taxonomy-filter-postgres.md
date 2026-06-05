---
"emdash": patch
---

fix(core/loader): avoid SELECT DISTINCT * on taxonomy-filtered queries for Postgres compatibility (#1355)

On Postgres, `SELECT DISTINCT *` fails when the content table contains a native `json` column (e.g. from a `portableText` field) because `json` has no equality operator. The taxonomy-filtered query now uses a subquery with `DISTINCT` on the join key (`ct.entry_id`) and selects `*` from the outer query, so filtering works on all dialects without a schema migration.
