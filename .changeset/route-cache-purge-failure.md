---
"emdash": patch
---

Fixes saves in the admin and through MCP reporting an error when the configured cache provider fails to purge, although the change was already saved. These saves now report success, and the failed purge is logged.
