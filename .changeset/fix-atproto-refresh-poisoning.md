---
"@emdash-cms/plugin-atproto": patch
---

Fixes AT Protocol syndication hanging on Cloudflare Workers when a request was cancelled while refreshing the session token. The token refresh is still coalesced so concurrent publishes don't race, but it no longer shares an in-flight promise that a cancelled request could leave pending forever; a later publish now recovers instead of hanging.
