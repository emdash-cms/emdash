---
"@emdash-cms/blocks": patch
---

Fixes `validateBlocks()` and `validateBlockResponse()` accepting unsupported `repeater` fields inside Block Kit `form` blocks. These validators now return an error at the field's `.type` path; content-editor repeaters remain supported.

Plugin authors must remove repeaters from plugin page forms, where they never rendered. Sites running sandboxed plugins with these invalid forms now receive `INVALID_BLOCK_RESPONSE` for the whole response, with the field path in server logs, instead of a page with missing fields. Affected site operators should update to a corrected plugin version or ask the plugin author to remove the unsupported fields. In-process plugin responses that bypass validation are unchanged.
