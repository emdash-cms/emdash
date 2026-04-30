---
"emdash": patch
---

Fixes site favicon injection so user-configured favicons render on the public site, including SVG favicons in Chromium browsers (#831). `EmDashHead` now emits a `<link rel="icon">` tag with the correct `type` attribute (e.g. `image/svg+xml`) sourced from the stored media's MIME type. Templates that already render their own favicon link continue to work; browsers tolerate the duplicate, and a follow-up cleanup can drop the per-template line.

`MediaReference` now carries `url`, `contentType`, `width`, and `height` when resolved via `resolveMediaReference`, so callers can emit correct head tags without a second round-trip to the media table.
