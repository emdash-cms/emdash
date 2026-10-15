---
"emdash": patch
"@emdash-cms/admin": patch
---

Explains why the WordPress exporter import can't connect when Cloudflare's bot protection answers with a challenge page. The URL check and the analyze and import steps now say that bot protection blocked the request and how to let it through, instead of reporting that WordPress couldn't be detected or that the analysis failed. In this case the analyze and execute endpoints return the `WP_SITE_CHALLENGE` error code with status 502, and probe results include `challenged: true`.
