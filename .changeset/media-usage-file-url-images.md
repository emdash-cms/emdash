---
"emdash": patch
---

Fixes **Used in** missing rich text images and videos that refer to a library file by its `/_emdash/api/media/file/` URL instead of its media ID. Markdown images written through MCP or the CLI are stored this way, so files placed by agents and scripts looked unused, even right after media usage tracking was turned on. These references are now indexed. On sites that already track media usage, collections with rich text or blocks fields are marked for reindexing after the upgrade, and **Used in** reports their index as stale. To reindex them, an administrator opens **Settings** > **Media usage tracking** and keeps the page open until the status reads **Ready**.

Saving rich text through the REST API, MCP, or the CLI now also stores the media ID (`asset._ref`) for these blocks when the URL matches a file in the media library, as images placed in the editor already have.
