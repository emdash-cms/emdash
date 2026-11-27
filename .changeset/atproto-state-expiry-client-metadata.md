---
"@emdash-cms/auth-atproto": patch
"emdash": patch
---

Fixes Atmosphere sign-in leaving records in the database that were never removed. An OAuth state now stops working 10 minutes after the sign-in starts, as intended, and scheduled cleanup deletes the states of sign-ins that were started and never finished. Before, every abandoned attempt left a row in `_plugin_storage` that stayed there.

Atmosphere sign-in also no longer stores the access and refresh tokens it receives from an account's provider. They were written for every completed callback, including accounts the site then refused, and never used again. Scheduled cleanup deletes the token sets stored by earlier versions.

The cleanup of existing rows needs `emdash` upgraded, and the 10-minute state expiry and the end of token storage need `@emdash-cms/auth-atproto` upgraded.

Also fixes `/.well-known/atproto-client-metadata.json` using the host of the incoming request for `client_id` and `redirect_uris`. It now uses `siteUrl` (or `EMDASH_SITE_URL`), the same origin the login route sends to the account's provider, so sign-in no longer fails behind reverse proxies that forward a different `Host`.
