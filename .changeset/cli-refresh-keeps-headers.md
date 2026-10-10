---
"emdash": patch
---

Fixes CLI commands failing behind Cloudflare Access once the access token saved by `emdash login` has expired. Refreshing the token now sends the custom headers from `--header`, `EMDASH_HEADERS` and `emdash login --header`, as every other request does.
