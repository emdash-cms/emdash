---
"emdash": minor
"@emdash-cms/cloudflare": minor
"@emdash-cms/sandbox-workerd": minor
---

Adds `getVersioned`, `compareAndSet` and `compareAndDelete` to plugin storage collections and `ctx.kv`. Native and sandboxed plugins can create an absent key or condition a replacement or deletion on the revision they read, preventing concurrent requests from silently overwriting each other.

Pass an explicit `null` revision to create only when absent. A successful replacement returns its new revision; a conflict returns `{ applied: false }`. Invalid input, permission failures and database failures reject the promise. Atomicity applies to one key, so changes spanning multiple records still require an application-level protocol.

Update core and the sandbox adapter together and apply the host database migrations before using the methods. The migration initializes existing records without a backfill. Stored values are preserved, and existing unconditional writes continue to work while invalidating old revisions. Conditional keys are limited to 1,024 JavaScript string characters and values to 1 MiB of UTF-8 JSON.
