---
"emdash": patch
---

Fixes WordPress media import to emit relative `/_emdash/api/media/file/...` URLs instead of absolute ones, matching every other media endpoint. Imported media is now recognized by `INTERNAL_MEDIA_PREFIX` for enrichment, and no longer pins URLs to the origin that happened to serve the import request (breaking renders on a different port or behind a reverse proxy).
