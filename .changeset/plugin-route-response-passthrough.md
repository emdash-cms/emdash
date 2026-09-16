---
"emdash": patch
---

Plugin API route handlers can now return a `Response` directly to serve non-JSON content — an image, a file, or anything with a custom content type. A returned `Response` is sent to the caller verbatim (status and headers included) instead of being wrapped in the standard `{ success, data }` JSON envelope; ordinary return values keep the envelope. A returned `Response` follows the same caching rule as the envelope: private routes always send `private, no-store`, and on a public route a `Cache-Control` the handler sets itself takes precedence over the route's `cacheControl`. Applies to trusted (configured) plugins; sandboxed plugin routes stay JSON-only because their results cross a serialization boundary.
