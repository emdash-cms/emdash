---
"emdash": patch
"@emdash-cms/admin": patch
---

Replaces the Change domain error "does not serve this site yet" with "Could not verify that … serves this site" when the server cannot verify a domain, including Cloudflare Workers Custom Domains. The dialog now explains that a Worker may be unable to reach its own domain and asks you to confirm the new address shows your site in a browser before using it without the check.
