---
"emdash": patch
"@emdash-cms/cloudflare": patch
---

Fixes the D1 and Durable Object read-replica bookmark cookies (`__em_d1_bookmark`, `__em_do_bookmark`) being set on requests that carry an `Authorization: Bearer` header the site never verified. The cookie is now set only for a signed-in session or a token the site has accepted, so a valid token sent to a public page no longer receives one. Requests with a Bearer header are still routed to the primary database.
