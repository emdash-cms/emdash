---
"@emdash-cms/auth-atproto": patch
"emdash": patch
---

Fixes Atmosphere sign-in OAuth states never expiring and never being removed. A state now stops working 10 minutes after the sign-in starts, as intended, and scheduled cleanup deletes the states of sign-ins that were started and never finished. Before, every abandoned attempt left a row in `_plugin_storage` that stayed there.

Also fixes `/.well-known/atproto-client-metadata.json` using the host of the incoming request for `client_id` and `redirect_uris`. It now uses `siteUrl` (or `EMDASH_SITE_URL`), the same origin the login route sends to the account's provider, so sign-in no longer fails behind reverse proxies that forward a different `Host`.
