---
"emdash": patch
---

Emit stream-end metrics when query instrumentation is enabled. Server-Timing db.\* counters are snapshotted when headers are sent, but Astro streams the body afterwards and components issue further DB queries that the headers can't report. With `EMDASH_QUERY_LOG=1`, the middleware now pipes the response body through an identity transform and emits a final `[emdash-stream-end]` NDJSON snapshot (db count/total, cache hits/misses, total elapsed) when the body finishes streaming, so the full request cost is observable. Zero overhead when instrumentation is disabled.
