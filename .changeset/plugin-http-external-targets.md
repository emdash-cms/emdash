---
"emdash": patch
"@emdash-cms/sandbox-workerd": patch
---

Fixes plugin HTTP requests with `allowedHosts` so initial URLs and redirects also pass SSRF validation. Requests are rejected when URL or DNS validation identifies an unsupported scheme or a non-public address.

Existing callers of the shared outbound URL validator also reject these non-public ranges.

The default validator resolves public hostnames through `cloudflare-dns.com` before dispatch. Self-hosted deployments must permit access to that endpoint when using the default resolver.
