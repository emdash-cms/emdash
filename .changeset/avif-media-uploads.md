---
"emdash": patch
"@emdash-cms/admin": patch
---

Fixes AVIF images being rejected with "File type not allowed" on upload. `image/avif` is back in the default media allowlist alongside PNG, JPEG, GIF, and WebP, so editors can upload `.avif` files again from the media library and from image fields that use the default allowlist.

The admin file picker now offers `.avif` files and renders their thumbnails, the built-in "Images" preset in a field's allowed-types editor includes AVIF, and `.avif` works as extension shorthand in a field's `allowedMimeTypes`.

SVG stays excluded from the default allowlist.
