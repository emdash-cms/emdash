---
"emdash": minor
"@emdash-cms/admin": minor
"@emdash-cms/cloudflare": patch
---

Adds cropping for JPEG, PNG, and WebP images stored by EmDash on local disk, Cloudflare R2, or S3-compatible storage.

Move and resize a rule-of-thirds crop frame with corner handles for fixed ratios and eight handles for Freeform. Choose the original ratio, Freeform, or a common aspect ratio. **Create cropped copy** creates a separate media item with any ratio and names it for the selected ratio or output dimensions. **Replace original** uses the original ratio and replaces the existing item under the same ID and URL, so every reference uses the cropped image without rewriting or republishing content. Local media and responsive renditions revalidate their stable URLs so sites load the replacement instead of keeping a stale cached image. The original bytes and crop history are not retained.
