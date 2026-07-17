---
"@emdash-cms/registry-verification": patch
---

Rejects additional IPv6-encoded private/metadata addresses in the verified-fetch SSRF guard: deprecated IPv4-compatible (`::a.b.c.d`) and NAT64 (`64:ff9b::a.b.c.d`) forms that embed a private or link-local IPv4 address are now resolved to their embedded address and blocked.
