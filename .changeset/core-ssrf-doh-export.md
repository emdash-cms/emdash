---
"emdash": patch
---

Adds a `emdash/security/ssrf` subpath export exposing the `cloudflareDohResolver` DNS-over-HTTPS resolver and the SSRF URL/address validation helpers for reuse in Workers that fetch untrusted URLs.
