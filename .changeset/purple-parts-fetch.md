---
"@emdash-cms/cloudflare": patch
---

Fixes `cloudflareImages()` and `cloudflareStream()` so their `*EnvVar` options (`accountIdEnvVar`, `accountHashEnvVar`, `apiTokenEnvVar`) read `process.env` on the Node adapter. Previously they only checked Cloudflare Workers bindings, so a Node-hosted site with credentials exported as environment variables failed with a "Missing ..." error even though the variable was set. A Cloudflare Workers binding of the same name still takes precedence when one exists.
