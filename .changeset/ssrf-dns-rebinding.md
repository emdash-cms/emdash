---
"emdash": patch
---

Strengthens SSRF protection on the import pipeline against DNS-rebinding. The `validateExternalUrl` helper now also blocks known wildcard DNS services (`nip.io`, `sslip.io`, `xip.io`, `traefik.me`, `lvh.me`, `localtest.me`) and trailing-dot FQDN forms of blocked hostnames. A new `resolveAndValidateExternalUrl` resolves the target hostname via DNS-over-HTTPS (Cloudflare) and rejects if any returned IP is in a private range. `ssrfSafeFetch` and the plugin unrestricted-fetch path now use the DNS-aware validator on every hop. This adds two DoH round-trips per outbound request; self-hosted admins whose egress blocks `cloudflare-dns.com` can inject a custom resolver via `setDefaultDnsResolver`.
