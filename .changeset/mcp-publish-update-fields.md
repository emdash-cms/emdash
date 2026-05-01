---
"emdash": minor
---

Adds `publishedAt` to `content_publish` (MCP and REST) and exposes `seo`, `bylines`, and `publishedAt` on the MCP `content_update` tool.

`content_publish` now accepts an optional ISO 8601 `publishedAt` to backdate a publish, which is useful when migrating content from another CMS or correcting a historical publish date. The override requires the `content:publish_any` permission. Without it, the existing `published_at` is preserved on re-publish (idempotent) and falls back to the current time on first publish.

The MCP `content_update` tool previously dropped `seo`, `bylines`, and `publishedAt` even though the underlying handler accepted them. Callers had to fall back to raw SQL against `_emdash_seo` and `_emdash_content_bylines` to set these fields. They now flow through the MCP tool and are persisted in the same transaction as field updates. Setting `publishedAt` requires `content:publish_any`, mirroring the REST PUT route. Closes #621 and #622.
