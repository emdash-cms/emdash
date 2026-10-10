---
"emdash": patch
---

Fixes CLI commands failing behind Cloudflare Access once the EmDash access token saved by `emdash login` has expired. Refreshing the token now sends the custom headers from `--header`, `EMDASH_HEADERS` and `emdash login`, as every other request does. `EmDashClient` from `emdash/client` now also runs the `interceptors` you pass on its automatic token refresh request.
