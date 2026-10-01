---
"emdash": patch
---

Adds `image/jxl` (JPEG XL) to the default media upload allowlist, so `.jxl` files can be uploaded without a field-specific MIME list. Upload routes now fall back to the filename extension when the browser reports an empty or generic MIME type, which is the common case for JPEG XL outside Safari.
