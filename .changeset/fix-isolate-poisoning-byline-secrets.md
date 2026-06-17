---
"emdash": patch
---

Fixes admin and content pages intermittently hanging and returning 524 timeouts on Cloudflare Workers. The per-isolate caches for byline custom-field definitions and resolved site secrets could retain a never-settling promise left behind by a cancelled request, which wedged every later request on that isolate until it was evicted. Both caches now cache the resolved value behind a reclaimable single-flight lock, so a cancelled request can no longer stall the isolate.
