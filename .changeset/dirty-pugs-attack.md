---
"@emdash-cms/cloudflare": minor
---

Adds an experimental opt-in `coalesce` option to the `d1()` adapter. When enabled (alongside `session`), SELECT queries issued in the same event-loop turn on the per-request session database are buffered and executed as a single D1 `batch()` call — one HTTP round trip instead of N fully-serialized ones. Writes, CTEs and other statements always execute immediately, and if a batch fails the buffered queries are retried individually so each keeps its own error semantics.
