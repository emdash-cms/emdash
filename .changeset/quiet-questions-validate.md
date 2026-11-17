---
"@emdash-cms/blocks": patch
---

Fixes `validateBlocks()` and `validateBlockResponse()` accepting unsupported `repeater` fields inside Block Kit `form` blocks. These validators now return an error at the field's `.type` path. Repeaters in Portable Text block field definitions are unaffected.

Plugin authors must remove repeaters from `form` blocks in plugin admin pages, widgets, and content-editor panels, where they never rendered. For sandboxed plugins' admin pages and widgets, and all plugins' content-editor panels (sandboxed or in-process), these invalid forms now cause `INVALID_BLOCK_RESPONSE` for the whole response, with the field path in server logs, instead of a view with missing fields. Affected site operators should update to a corrected plugin version or ask the plugin author to remove the unsupported fields. In-process admin page and widget responses that bypass validation are unchanged.
