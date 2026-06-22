---
"emdash": patch
---

Lets the MCP `content_create` and `content_update` tools accept a Markdown string for rich text (portableText) fields, converting it to Portable Text automatically — the same behaviour the EmDash client already has. Passing a Portable Text JSON array still works. Authoring rich text as a single Markdown string avoids the large nested JSON payloads that agents frequently emit as malformed JSON, causing the tool call to fail before it reaches the server. `content_get` and `content_list` gain an optional `markdown` flag (default false) that returns rich text fields as Markdown instead of Portable Text arrays.
