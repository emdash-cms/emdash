---
"emdash": minor
---

Updates the `sqlite()` adapter and CLI to use Node's built-in `node:sqlite` driver instead of better-sqlite3. SQLite sites no longer depend on a natively compiled binary, which removes `NODE_MODULE_VERSION` rebuild errors after Node upgrades and glibc incompatibilities on shared hosting.

Requires Node.js 22.15 or later. If you are on an older Node 22 release, upgrade Node before updating.

Connection pragmas are now applied wherever the package opens a SQLite database, so sites using the runtime `sqlite()` adapter get the same settings the CLI already applied: `journal_mode = WAL` (readers no longer block on the writer, and FTS5 shadow tables survive a mid-write process kill), `busy_timeout = 5000` (a competing writer waits instead of failing with `SQLITE_BUSY`), and `foreign_keys = ON`.

Query parameters are normalized so binding behaviour matches the old driver: `undefined` binds as `NULL` (accepted by better-sqlite3, rejected by `node:sqlite`), and a `Date` raises an actionable error instead of silently binding `NULL`. Booleans now bind as `0`/`1` — neither driver accepted them before, so boolean filters that previously threw at bind time (for example the plugin storage query API, whose `WhereValue` type has always advertised `boolean`) now work.
