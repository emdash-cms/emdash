---
"emdash": patch
---

Fixes the default media upload allowlist accepting `image/svg+xml` via its bare `"image/"` prefix match, with no upload-time content validation for SVG. A logged-in Contributor+ user could upload an SVG containing an embedded `<script>`; the global allowlist now enumerates safe raster types (`image/png`, `image/jpeg`, `image/gif`, `image/webp`) explicitly instead of prefix-matching all `image/*`. Fields that explicitly configure `image/svg+xml` in their own `allowedMimeTypes` are unaffected.
