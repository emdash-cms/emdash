---
"emdash": patch
---

Fixes Postgres server bundles importing `better-sqlite3`, which crashed production starts (`pnpm preview`, `pnpm start`) with `ERR_MODULE_NOT_FOUND` because the SQLite driver is not installed in Postgres-only deployments. Moved `EmDashDatabaseError` into a new SQLite driver-free `database/errors.ts` and re-exported it from there, so the `better-sqlite3` import doesn't leak into the Postgres build.
