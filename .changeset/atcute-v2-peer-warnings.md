---
"emdash": patch
"@emdash-cms/admin": patch
"@emdash-cms/plugin-cli": patch
"@emdash-cms/registry-client": patch
"@emdash-cms/auth-atproto": patch
"@emdash-cms/registry-lexicons": patch
---

Fixes `@atcute` peer dependency warnings on install (#1435)

Installing EmDash pulled in mismatched `@atcute` package versions, so `pnpm install` / `npm install` reported unmet peer warnings for `@atcute/identity` and `@atcute/lexicons`. The bundled `@atcute` dependencies are now aligned on v2 and installs are clean. If your project also depends on `@atcute` packages directly, note they have moved to v2 (`@atcute/client` 5, `@atcute/lexicons` 2, `@atcute/atproto` 4, `@atcute/oauth-node-client` 2).
