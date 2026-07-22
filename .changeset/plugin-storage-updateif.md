---
"emdash": minor
---

feat(plugins): add `ctx.storage.<collection>.updateIf(id, { where, set?, delta? })` — a predicate-guarded atomic update for plugin storage. The guard and the arithmetic run in a single `UPDATE … WHERE <guard> RETURNING` (no read-then-write), so N concurrent guarded decrements serialize correctly — the no-oversell primitive. `set` writes wholesale field values; `delta` applies integer `inc`/`dec` in-SQL over `COALESCE(base, 0)`. Returns `{ applied: true, data }` or `{ applied: false }` (row absent or guard failed — never inserts). Works on SQLite and Postgres via `json_set`/`jsonb_set` with the numeric-correct guard translation.
