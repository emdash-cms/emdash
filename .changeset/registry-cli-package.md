---
"@emdash-cms/registry-cli": patch
"@emdash-cms/registry-client": patch
"@emdash-cms/registry-lexicons": patch
---

Adds `@emdash-cms/registry-cli`: standalone CLI for the experimental plugin registry. Subcommands for `login`, `logout`, `whoami`, `search`, `info`, and a `publish` stub. Atproto OAuth via loopback callback server. Distributes via `npx @emdash-cms/registry-cli` to keep atproto deps out of the core CMS install. Also switches `@emdash-cms/registry-client` and `@emdash-cms/registry-lexicons` from shipping TypeScript source to building to `dist/` via tsdown.
