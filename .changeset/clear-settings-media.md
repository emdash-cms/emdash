---
"emdash": patch
"@emdash-cms/admin": patch
---

Fixes the General and SEO settings screens so removing the site logo, favicon, or default social image remains cleared after saving. REST, MCP, and `setSiteSettings()` callers can remove these media references by setting them to `null`; omitted settings remain unchanged.
