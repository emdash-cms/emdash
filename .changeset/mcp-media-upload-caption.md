---
"emdash": patch
---

Adds an optional `caption` to the MCP `media_upload` tool, stored on the media record next to `alt`. The tool previously had no caption, and its schema dropped an unknown `caption` argument without an error, so a caption sent with an upload (often the picture's credit) was lost and the record stored none.
