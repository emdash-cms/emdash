---
"emdash": patch
---

Fixes query instrumentation (`EMDASH_QUERY_LOG=1`) so the per-query NDJSON log captures queries issued while the page is still streaming, not just those that ran before the response headers were sent. The per-query log now matches the totals already reported by the `[emdash-stream-end]` summary line.
