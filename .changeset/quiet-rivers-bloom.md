---
"emdash": minor
---

Renders local media through storage `publicUrl` when configured. `EmDashImage` and the Portable Text image block now call a new `locals.emdash.getPublicMediaUrl()` helper, so R2 and S3 deployments with a custom domain serve images from that domain. `S3Storage.getPublicUrl` now returns the `/_emdash/api/media/file/{key}` path when no `publicUrl` is set (previously `{endpoint}/{bucket}/{key}`).
