---
"emdash": patch
---

Trusted (non-sandboxed) plugin route handlers can now return a raw `Response` — redirects, `Set-Cookie` session flows, streamed bodies — and have it dispatched to the client without the `apiSuccess` JSON envelope or a header allowlist. The dispatch layer still applies its Cache-Control policy to the passthrough: a response gets `private, no-store` unless the handler set its own `Cache-Control`, or the route is public with a declared `cacheControl` on a GET/HEAD request.
