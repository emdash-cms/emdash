---
"emdash": patch
---

Fixes `comment:afterCreate` hooks being cut short on Cloudflare Workers. The hooks for a new comment ran as fire-and-forget work that the host did not keep alive, so they could be cancelled as soon as the response was sent. Sandboxed plugins, which call back into the host for settings and email, were stopped at their first call and never ran: a plugin that emails admins about new comments sent nothing. These hooks now run through the host's `waitUntil`, after the response, until they finish.
