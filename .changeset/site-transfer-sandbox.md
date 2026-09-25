---
"@emdash-cms/cloudflare": patch
"@emdash-cms/sandbox-workerd": patch
---

Updates sandboxed plugin content writes to respect the site transfer write fence. While a site import is writing, or after a failed or cancelled import until it is abandoned, `ctx.content` create, update, and delete calls fail with `503 TRANSFER_IMPORT_IN_PROGRESS`. When the fence cannot be checked, they now fail with `TRANSFER_FENCE_CHECK_FAILED` instead of `MEDIA_USAGE_ACTIVATION_CHECK_FAILED`.
