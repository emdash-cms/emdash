---
"@emdash-cms/cloudflare": minor
---

Adds a `hyperdrive()` database adapter for connecting EmDash on Cloudflare Workers to a PostgreSQL (or PostgreSQL-compatible, e.g. PlanetScale Postgres) database through a Hyperdrive binding. Configure it with `database: hyperdrive({ binding: "HYPERDRIVE" })`. Each request gets its own pooled connection that is opened and closed within that request — connections cannot be reused across Worker requests. Requires `pg >= 8.16.3`, the `nodejs_compat` compatibility flag, and a compatibility date of `2024-09-23` or later. Disable Hyperdrive query caching for the configuration so the admin's read-after-write stays consistent.

The content read/write path (pages, content API routes, loaders) is fully supported. Cron Triggers (scheduled publishing, plugin cron, system cleanup), plugin hooks that query the database, and sandboxed plugins are not yet supported on this adapter — they use a per-isolate connection that workerd will not reuse across events. Use `d1()` if your deployment depends on those.
