---
"emdash": patch
---

Fixes the MCP `content_create` tool so it accepts optional `seo` and `publishedAt` fields and persists them in the same call. Agents no longer need to create a post and then call `content_update` just to set SEO metadata or backdate an item. `publishedAt` is gated behind the `content:publish_any` permission, matching the REST API and `content_update`.
