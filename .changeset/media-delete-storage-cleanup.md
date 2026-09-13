---
"emdash": patch
---

Media deletion no longer leaves files behind. The MCP `media_delete` tool and the plugin `ctx.media.delete()` API now remove the stored file as well as the record, matching the admin API. When the storage delete fails, `DELETE /_emdash/api/media/:id` reports `storageDeleted: false` instead of a plain success, and the periodic cleanup retries the file deletion until it succeeds.
