---
"@emdash-cms/registry-client": patch
---

Sends an explicitly empty `atproto-accept-labelers` header when `DiscoveryClient` is configured with `acceptLabelers: ""`, so "accept no labelers" is honored instead of being dropped and letting the aggregator apply its trusted defaults. Omitting the option entirely still sends no header.
