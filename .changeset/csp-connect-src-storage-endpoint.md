---
"emdash": patch
---

Fixes admin media uploads to S3-compatible storage (R2, S3, Minio, etc.) being blocked by the Content-Security-Policy when the storage endpoint is a different origin than the site. The signed upload URL's origin is now allowed in `connect-src`.
