---
"emdash": minor
---

Adds a `media_upload` MCP tool that uploads a file from base64-encoded data or a public URL and registers it in the media library, so agent workflows can create media without dropping to the CLI or raw API. Uploads are deduplicated by content hash and respect the global MIME allowlist and maximum upload size.
