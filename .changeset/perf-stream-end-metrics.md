---
"emdash": patch
---

Query instrumentation (`EMDASH_QUERY_LOG=1`) now captures the whole request, not just the part before the response headers are sent. Queries issued by components while the page is still streaming were previously invisible to the Server-Timing numbers; a final `[emdash-stream-end]` log line now reports the complete query count, database time, and cache hits for each request, so you can see where a slow page really spends its time. No effect when instrumentation is off.
