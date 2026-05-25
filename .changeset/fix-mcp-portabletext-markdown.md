---
"emdash": patch
---

Fixes the MCP `content_create` and `content_update` tools rejecting a markdown string in a `portableText` field with `expected array, received string`. Markdown strings in rich-text fields are now converted to Portable Text before validation, matching the `emdash` CLI client — so MCP callers can write rich text as markdown instead of hand-assembling Portable Text JSON (`_key`s, `markDefs`, block shapes), which LLM clients do unreliably. Existing Portable Text arrays are passed through unchanged.
