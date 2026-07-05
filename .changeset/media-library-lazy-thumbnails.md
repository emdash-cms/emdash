---
"emdash": patch
---

Fixes slow load and scroll on the Media Library admin page. Thumbnails now use native `loading="lazy"` so the browser only fetches images as they scroll into view, instead of firing every visible page's worth of resize requests on mount. The initial page size is also reduced from 100 to 40 items.
