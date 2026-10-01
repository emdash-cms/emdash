---
"emdash": patch
---

Fixes returning visitors seeing a stale page after a content publish until the next deploy. A cached page whose `Astro.cache.set()` hints carry no last-modified time no longer sends the build time as `Last-Modified`, so browsers download the page again instead of receiving a 304. The fix applies to pages that pass no hint and to pages that pass only tag hints, such as those from `getSiteSettingsWithCacheHint()` and `getMenuWithCacheHint()` or from a query that returned no entries. Pages whose hints carry a last-modified time, such as those from `getEmDashEntry()`, still revalidate against both the content and the build.
