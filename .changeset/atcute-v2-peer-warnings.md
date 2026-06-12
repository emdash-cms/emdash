---
"emdash": patch
"@emdash-cms/admin": patch
"@emdash-cms/plugin-cli": patch
"@emdash-cms/registry-client": patch
"@emdash-cms/auth-atproto": patch
"@emdash-cms/registry-lexicons": patch
---

Align the Atcute dependency tree on v2 to clear peer warnings on install (#1435). `@atcute/identity-resolver@2` and `@atcute/identity@2` require `@atcute/lexicons@^2`, but the catalog still pinned `@atcute/client@4`, `@atcute/lexicons@1`, `@atcute/atproto@3`, and `@atcute/oauth-node-client@1`, which dragged v1 `lexicons`/`identity` into the published tree. Bumps `@atcute/client` to `^5`, `@atcute/lexicons` to `^2`, `@atcute/atproto` to `^4`, and `@atcute/oauth-node-client` to `^2`. The only API change is `parseCanonicalResourceUri` now throwing instead of returning a result object.
