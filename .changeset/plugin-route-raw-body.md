---
"emdash": minor
---

Adds opt-in raw request body access for native plugin routes: set `rawBody: true` on a route to receive the unparsed body as `ctx.rawBody`, enabling webhook signature verification and non-JSON payloads.
