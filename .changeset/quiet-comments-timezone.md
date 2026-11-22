---
"emdash": patch
---

Fixes `<Comments>` dates to use the site's Timezone setting instead of the server's timezone, including dates on threaded replies. Missing or invalid timezone settings use UTC, including on Node.js servers configured with a different local timezone. Set the site's Timezone to keep dates in your preferred timezone.
