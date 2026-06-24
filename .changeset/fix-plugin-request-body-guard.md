---
"emdash": patch
---

Plugin route handlers that call `ctx.request.json()` (or `.text()`, `.formData()`, `.arrayBuffer()`, `.blob()`) now get a clear error pointing them to `ctx.input` instead of the runtime's cryptic "Body has already been read" failure (#1293). EmDash parses the request body once before the handler runs and exposes it as `ctx.input`, leaving `ctx.request`'s stream consumed; the request handed to handlers now guards those body-reading methods with an actionable message. All other request members (`url`, `method`, `headers`, `signal`, …) are unaffected.
