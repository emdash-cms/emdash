---
"emdash": patch
---

Fixes site favicon injection so user-configured favicons render on the public site, including SVG favicons in Chromium browsers (#831). `EmDashHead` now emits a `<link rel="icon">` tag with the correct `type` attribute (e.g. `image/svg+xml`) sourced from the stored media's MIME type. The bundled templates and demos have been updated to drop their per-template favicon link in favour of the centralized injection; existing user sites that still emit their own `<link rel="icon">` continue to work because browsers tolerate the duplicate.

`MediaReference` now carries `url`, `contentType`, `width`, and `height` when resolved via `resolveMediaReference`, so callers can emit correct head tags without a second round-trip to the media table.
