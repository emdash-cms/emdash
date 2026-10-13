---
"emdash": patch
---

Fixes oversized plugin screenshots failing to load in the admin registry gallery with HTTP 413.

The registry artifact proxy now requests the `feed_fullsize` image preset for screenshots instead of `feed_thumbnail`. This aligns the admin preview with the public plugin site and avoids the lossless upscaling that pushed modest source images over the 1 MiB proxy cap.
