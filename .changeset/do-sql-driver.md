---
"@emdash-cms/cloudflare": minor
---

Adds a `durableObjects()` database adapter that stores the whole CMS in a single Durable Object's SQLite. With `session: "auto"` (plus the `experimental` and `replica_routing` compatibility flags) reads route to the nearest read replica and writes proxy to the primary, cutting read latency for globally distributed traffic. Register the exported `EmDashDB` class in your worker and add a `new_sqlite_classes` migration.
