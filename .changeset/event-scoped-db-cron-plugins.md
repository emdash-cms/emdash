---
"emdash": patch
---

Resolves the database connection at use-time for the cron sweep, plugin hook contexts, and media providers instead of capturing it once at startup. This makes scheduled publishing, plugin cron, and database-querying plugin hooks work on connection-backed adapters like Postgres over Cloudflare Hyperdrive, where a connection is bound to the event that opened it. Stateless adapters (D1, Node SQLite) are unaffected.
