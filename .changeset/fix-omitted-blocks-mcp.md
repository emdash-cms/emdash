---
"emdash": patch
---

Fixes MCP `content_create` and `content_update` rejecting writes that omit a blocks field with "must be an array". Omitted blocks fields now use an empty array on create and retain their existing value on update; supplied non-array values are still rejected.

JS client reads also preserve omitted blocks fields instead of adding them with an `undefined` value.
