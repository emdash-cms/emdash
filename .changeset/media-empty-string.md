---
"emdash": patch
---

Fixes saving an entry turning an empty image or file field (`""`) into `{ "provider": "external", "id": "", "src": "" }`. A blank image or file field, or a blank image inside a repeater, is now saved as `null`, the canonical empty value. Entries with no image stop changing on every save after that.

A required image or file field now returns a validation error for `""` instead of saving an empty image. This only affects API, MCP or import clients, because the admin never sends `""`.
