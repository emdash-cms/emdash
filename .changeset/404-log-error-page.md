---
"emdash": patch
---

Fixes the 404 log counting the site's own /404 error page as a missed path. Every content miss that redirects to /404 was logged twice — once for the real missing path and once for "/404" itself — inflating the 404 summary with a meaningless top entry. Hits on /404 are no longer logged.
