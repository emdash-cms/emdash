---
"emdash": minor
---

Adds `trustedProxyHeaders` config option so self-hosted deployments behind a reverse proxy can declare which client-IP headers to trust. Used by auth rate limits (magic-link, signup, passkey, OAuth device flow) and the public comment endpoint — without it, every request on a non-Cloudflare deployment was treated as "unknown" and rate limits were effectively disabled.

Set the option in `astro.config.mjs`:

```js
emdash({
	trustedProxyHeaders: ["x-real-ip"], // nginx, Caddy, Traefik
});
```

or via the `EMDASH_TRUSTED_PROXY_HEADERS` env var (comma-separated). Headers are tried in order; values ending in `forwarded-for` are parsed as comma-separated lists.

Also removes the user-agent-hash fallback on the comment endpoint. The fallback was meant to give anonymous commenters on non-Cloudflare deployments something approximating per-user rate limiting, but the UA is trivially rotatable; requests with no trusted IP now share a stricter "unknown" bucket. Operators behind a reverse proxy should set `trustedProxyHeaders` to restore per-IP bucketing.

**Only set `trustedProxyHeaders` when you control the reverse proxy.** Trusting a forwarded-IP header from the open internet lets any client spoof their IP and defeats rate limiting.
