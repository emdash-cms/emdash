---
"emdash": patch
---

Fixes MCP `content_create` and `content_update` rejecting writes that omit a blocks field with "must be an array". A create that omits a blocks field treats it as empty, and an update keeps the stored blocks. Supplied non-array values are still rejected.
