---
"emdash": patch
---

Fixes standalone wildcard "*" in plugin allowedHosts so plugins declaring allowedHosts: ["*"] can make outbound HTTP requests to any host.
