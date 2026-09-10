---
"emdash": patch
---

Fixes the generated OpenAPI `ApiError` type to expose the optional `error.details` object already returned by EmDash APIs. OpenAPI client generators can now include structured error context in their generated types.
