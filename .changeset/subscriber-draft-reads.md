---
"emdash": patch
---

Fixes Subscribers, and other users without `content:read_drafts`, seeing unpublished content through the content API and MCP tools. Asking for the terms or translations of a draft or scheduled entry now returns not found, and MCP `content_get` returns only the published version of an entry with unpublished changes.
