---
"emdash": patch
---

Fix Postgres dialect misdetection under minification. When emdash is bundled and minified by the consuming app (for example an Astro SSR production build), the `PostgresAdapter` class name is mangled, so `detectDialect` fell back to SQLite and emitted SQLite-only SQL such as `datetime('now')` — failing the first migration on Postgres with `function datetime(unknown) does not exist`. Detection now also checks the adapter's `supportsMultipleConnections` capability, which survives minification.
