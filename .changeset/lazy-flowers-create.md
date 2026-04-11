---
"emdash": patch
---

Fixes standalone wildcard "_" in plugin allowedHosts so plugins declaring allowedHosts: ["_"] can make outbound HTTP requests to any host.
