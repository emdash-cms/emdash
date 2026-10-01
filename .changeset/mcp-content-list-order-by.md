---
"emdash": patch
---

Fixes the MCP `content_list` tool suggesting `created_at` and `updated_at` for `orderBy`, which it rejects with a validation error. The tool description now lists only fields it accepts: `createdAt`, `updatedAt`, `publishedAt`, `scheduledAt`, `slug`, `status`, `locale`, and field slugs that are indexed or set as the collection's `titleField` or `dateField`.
