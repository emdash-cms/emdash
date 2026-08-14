---
"emdash": patch
---

Standard-format plugins (`definePlugin(...)`) run trusted via `plugins: []` now receive the public single-arg `RouteContext` in their route handlers. Previously the in-process adapter always used the sandboxed two-arg calling convention, so a handler written against the exported `RouteContext` API got only `{ input, request, requestMeta }` at runtime — `ctx.storage`, `ctx.email`, `ctx.kv`, and every other capability surface were `undefined` and any route touching them threw. Sandbox-format entries (no `id` on the default export) keep the two-arg flattened convention unchanged.
