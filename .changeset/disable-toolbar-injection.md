---
"emdash": patch
---

fix: disable toolbar injection from request-context middleware

The middleware was injecting the editor toolbar by string-replacing `</body>` in every HTML response for authenticated editors. This approach is fragile — it buffers the entire response body in memory, breaks streaming, and can corrupt responses that legitimately contain `</body>` in their content. Toolbar injection is disabled until a proper client-side mount approach is implemented.
