---
"@emdash-cms/cloudflare": patch
---

Fixes affected-row counts on the Durable Object SQL database backend. Writes now report the number of changed table rows instead of `rowsWritten`, which also counts index entries, so row-count checks such as fencing a collection for deletion with media usage tracking enabled no longer fail on indexed tables.
