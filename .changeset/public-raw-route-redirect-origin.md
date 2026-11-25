---
"emdash": patch
---

Fixes redirects from public raw plugin routes on sites behind a TLS-terminating proxy. The host now checks a plugin's `Location` against the site's public origin from `siteUrl` or `EMDASH_SITE_URL`, not the internal request URL, and treats a value with a scheme, such as `http:other.example/path`, as an absolute URL. As a result, an absolute redirect to the site's public `https://` address is accepted, and one to another host or to the same host over `http://` is refused. When `siteUrl` or `EMDASH_SITE_URL` is set, absolute redirects must use that origin, so use a relative path such as `/thanks` to stay on whichever host served the request. Relative redirects are unaffected.
