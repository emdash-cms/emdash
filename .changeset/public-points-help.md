---
"@emdash-cms/cloudflare": patch
---

Fixes sandboxed plugins with the `email:send` capability being unable to send mail on Cloudflare Workers. `ctx.email.send()` could reject with "Email is not configured" even though a host email provider was configured and the host's own emails were delivered.
