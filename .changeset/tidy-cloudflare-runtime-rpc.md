---
"emdash": patch
"@emdash-cms/cloudflare": patch
"@emdash-cms/plugin-test": patch
---

Fixes sandboxed plugin `ctx.taxonomies` mutations (`createTerm()`, `addEntryTerms()`, and `removeEntryTerms()`), `ctx.content.create()`, versioned content actions (`getVersioned()`, `publish()`, `unpublish()`, `schedule()`, `unschedule()`, `getTrashedVersioned()`, and `restore()`), and `ctx.comments.setStatus()` on Cloudflare when requests run across multiple Worker isolates. Content creation consistently uses runtime validation and hooks and preserves `translationOf` links instead of falling back to a plain database insert.

Runner-created invocations without a content-create callback now receive `Content creation is not configured` rather than a database insert that bypasses runtime behavior. `createPluginTestHost()` supplies a database-backed callback with content-handler validation so transport-level tests can continue creating content and linked translations without starting the full EmDash runtime. It preserves the transport host's support for `data.slug` and `data.status`.

Await these operation promises before returning from a plugin route or hook. Their RPC connection now lasts only for that invocation; unlike the previous loopback binding, it cannot support work that outlives the invocation.

Publication after-hooks remain deferred. Same-entry actions attempted while an after-hook is running can return `CONTENT_ACTION_REENTRANT`; faster callback routing can expose this overlap in tests that assumed hooks had already finished. In runtime-host tests, call `await host.waitForDeferredTasks()` after an action before inspecting its after-hook effects or starting another action on the same entry. This method waits for queued deferred runtime work, including work those tasks enqueue; it does not run future scheduled tasks or wait for arbitrary unawaited plugin operations.
