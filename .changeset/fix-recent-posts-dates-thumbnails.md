---
"emdash": patch
---

Fixes the `core:recent-posts` widget so it shows each post's publication date and thumbnail. Dates use the page's locale and the site's configured timezone, falling back to UTC when the timezone setting isn't recognized. The widget doesn't apply the `dateFormat` setting; dates always use the locale's long format, such as "October 1, 2026" in English. Thumbnails render at up to 96 pixels wide instead of at full size.
