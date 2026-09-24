---
"emdash": patch
"@emdash-cms/admin": patch
---

Fixes the Media Library **Used in** tab reporting no usage for a file selected as the site logo, favicon, or default social image. Those settings appear as a **Site Settings** result, `GET /_emdash/api/media/{id}/usage` lists them in a new `siteSettings` array, and `usage.count` includes them. An empty **Used in** tab now says "No tracked references found" and names what is not checked, such as custom rich text blocks, instead of stating that the file is not used in any content.
