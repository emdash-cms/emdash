---
"emdash": patch
---

Preserves structured error codes through MCP tool responses. Errors returned by MCP tools now include a stable `[CODE]` prefix in the message text and a `_meta.code` field on the response envelope, so MCP clients can distinguish failure modes (e.g. NOT_FOUND, CONFLICT, VALIDATION_ERROR) instead of seeing only a generic message.
