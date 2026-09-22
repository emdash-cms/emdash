---
"emdash": patch
---

Fix 404 logging on PostgreSQL. Recording a missed path failed with `column reference "hits" is ambiguous`, so the 404 log stayed empty and hit counts never incremented on Postgres. The 404 Errors tab and its hit counters now populate correctly.
