---
"emdash": patch
---

Fixes the admin marketplace plugin icon and theme thumbnail proxies following redirects off the marketplace origin, which could make the server fetch an internal or loopback URL and return the response to any user with plugin read access (Editor and above). Sites with `marketplace` configured are affected. Redirects that stay on the marketplace origin still work; others now return `502` with `PROXY_REDIRECT_UNTRUSTED`, and chains longer than five hops return `502` with `PROXY_TOO_MANY_REDIRECTS`.
