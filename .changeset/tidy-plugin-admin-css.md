---
"emdash": patch
---

Fixes stylesheets imported by a plugin's `adminEntry` appearing on public pages in production builds. Plugin admin styles now load with the admin app without adding render-blocking stylesheet requests for public visitors.
