---
"@emdash-cms/cloudflare": patch
---

Fixes the `durableObjects()` database adapter retrying every coalesced read one by one after the Durable Object rejects the batch as overloaded, which added load to an object that was already overloaded. Those reads now fail with the original overload error.
