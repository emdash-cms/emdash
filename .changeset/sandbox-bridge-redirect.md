---
"@emdash-cms/cloudflare": patch
---

Sandboxed plugin HTTP requests now follow redirects manually and re-validate the destination at every hop. The allowedHosts list is checked on each redirect target (not just the initial URL), so an allowed host that 302s to a disallowed one no longer bypasses the scope. Credential headers (Authorization, Cookie, Proxy-Authorization) are stripped on cross-origin redirects. `network:fetch:any` and `allowedHosts: ["*"]` now still reject literal private IPs, cloud-metadata addresses, and known internal hostnames — the allowlist scopes which public hosts a plugin may reach, not whether SSRF protection applies. Non-http(s) URL schemes are rejected. Caps redirect chains at 5 hops.
