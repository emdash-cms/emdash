---
"emdash": patch
---

Fix MCP `media_upload` dropping the `caption` argument.

The `media_upload` tool now accepts an optional `caption` field and stores it on the media record, matching `media_update` and the admin media editor. Previously the tool's input schema only exposed `filename`, `base64`, `contentType`, and `alt`, so a passed `caption` was silently stripped and the record was created with `caption: null`.
