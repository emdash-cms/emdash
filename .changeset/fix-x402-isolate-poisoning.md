---
"@emdash-cms/x402": patch
---

Fixes x402-protected routes hanging and returning 524 timeouts on Cloudflare Workers when the very first request to a cold isolate was cancelled mid-initialization. The resource server is now cached only once it is fully initialized, so a cancelled initializer no longer strands later requests.
