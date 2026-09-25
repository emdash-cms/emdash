---
"emdash": patch
---

Updates the `media_upload` MCP tool to accept base64-encoded content only. Pass the file bytes and `contentType`; callers that previously passed `url` must download the file before calling the tool.
