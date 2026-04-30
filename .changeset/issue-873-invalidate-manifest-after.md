---
"emdash": patch
---

Fixes `EmDashRuntime.invalidateManifest()` leaving the persisted manifest cache row stale on Cloudflare Workers. The D1 row delete was a fire-and-forget promise — on Workers, unawaited work is cancelled when the isolate is torn down post-response, so `options.emdash:manifest_cache` was almost never actually wiped after a schema mutation. Cold-starting isolates downstream then adopted the pre-mutation snapshot and served `Collection '<slug>' not found` until something else cleared the row. The delete now goes through `after()`, which hands it to `ctx.waitUntil` under workerd. (#873)
