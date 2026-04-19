---
"emdash": patch
---

Cache `getSiteSetting(key)` per-request. It was firing an uncached `options` table read on every call, so templates that pull several settings (or `EmDashHead` reading `seo` on every page render) paid N round-trips to the D1 primary instead of sharing one. Noticeable on colos far from the primary — APS/APE were seeing ~30–100 ms of avoidable warm-render latency per page.

Wraps each key in `requestCached("siteSetting:${key}", ...)` so concurrent callers in a single render share the in-flight query.
