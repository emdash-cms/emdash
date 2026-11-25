---
"emdash": patch
---

Fixes redirects from public raw plugin routes on sites behind a TLS-terminating proxy. The host now checks a plugin's `Location` against the site's public origin from `siteUrl` or `EMDASH_SITE_URL`, not the internal request URL, and treats a value with a scheme, such as `http:other.example/path`, as an absolute URL. As a result, an absolute redirect to the site's public `https://` address is accepted, and one to another host or to the same host over `http://` is refused. Relative redirects such as `/thanks` are unaffected.
