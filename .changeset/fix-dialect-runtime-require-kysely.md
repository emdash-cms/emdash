---
"emdash": patch
---

Fixes "Cannot find module 'kysely'" at runtime after `astro build` followed by `astro preview` or `node dist/server/entry.mjs` on Node deployments using SQLite or libSQL (#741). The SQLite and libSQL dialect runtime modules used CJS `require("kysely")` and `require("better-sqlite3")`, ostensibly to defer loading at config time — though in practice these modules are only ever loaded at runtime via `virtual:emdash/dialect`, so the deferral served no purpose. Vite preserved those literal `require()` calls in the bundled SSR chunks; under pnpm's strict `node_modules` layout, Node's CJS resolver could not find `kysely` (a transitive dep of `emdash`) from the user's `dist/server/chunks/` directory. The dialect modules now use static imports — matching the existing `db/postgres.ts` adapter — so Vite resolves the deps correctly at build time.
