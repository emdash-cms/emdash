---
"emdash": patch
"@emdash-cms/cloudflare": patch
---

Fixes Cloudflare binding failures during runtime startup returning `NOT_CONFIGURED` from EmDash API routes. Missing D1, R2, KV, Durable Object, and Hyperdrive bindings now return `BINDING_NOT_FOUND` with the binding-specific setup message. Invalid KV and Hyperdrive binding configuration returns `CONFIGURATION_ERROR`.
