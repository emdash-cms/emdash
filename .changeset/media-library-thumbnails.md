---
"@emdash-cms/admin": patch
---

Speeds up browsing and searching large media libraries. The media library and the media picker now load small resized thumbnails through Astro's image endpoint instead of fetching every grid item's full-size original, so opening the library and searching for older items no longer waits on full-resolution downloads ([#1488](https://github.com/emdash-cms/emdash/issues/1488)). Where no runtime image service is available the original is served as before, so nothing renders worse than it did.
