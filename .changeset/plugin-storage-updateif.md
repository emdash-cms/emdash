---
"emdash": minor
"@emdash-cms/cloudflare": patch
"@emdash-cms/sandbox-workerd": patch
---

Adds `ctx.storage.<collection>.updateIf(id, { where, set?, delta? })` for atomic conditional updates to existing plugin documents. Use `where` to check stored fields, `set` to replace field values, and `delta` to increment or decrement integer counters. The method returns `{ applied: true, data }` with the updated document, or `{ applied: false }` when the document is absent or the condition fails. It never inserts a document.

Malformed update arguments reject without writing. Deltas require safe integer operands and results; missing or `null` counters start at `0`. Invalid stored counters, overflow, and non-object documents return `{ applied: false }` without changing any fields.

Available to native plugins and sandboxed plugins on Cloudflare and Workerd, with SQLite, D1, and PostgreSQL support. PostgreSQL serialization failures and deadlocks expose `code: "STORAGE_SERIALIZATION_FAILURE"` and `retryable: true`, including across sandbox transports. Retry standalone calls with bounded backoff, or restart the entire explicit transaction.
