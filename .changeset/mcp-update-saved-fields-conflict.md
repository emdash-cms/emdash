---
"emdash": patch
---

Fixes MCP `content_update` reporting a plain conflict after it had already saved field changes. When it saves the fields and the publish or unpublish requested with `status` then conflicts, the `CONFLICT` error now says the fields were saved and returns their new `_rev` in `details._rev`, so an agent can retry the status change without sending the fields again.
