---
"emdash": minor
---

Updates the `sqlite()` adapter and CLI to use Node's built-in `node:sqlite` driver instead of better-sqlite3. SQLite sites no longer depend on a natively compiled binary, which removes `NODE_MODULE_VERSION` rebuild errors after Node upgrades and glibc incompatibilities on shared hosting.

Requires Node.js 22.15 or later. If you are on an older Node 22 release, upgrade Node before updating.
