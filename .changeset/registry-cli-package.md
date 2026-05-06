---
"@emdash-cms/registry-cli": patch
"@emdash-cms/registry-client": patch
"@emdash-cms/registry-lexicons": patch
---

Adds `@emdash-cms/registry-cli`: standalone CLI for the experimental plugin registry. Subcommands for `login`, `logout`, `whoami`, `switch`, `search`, `info`, `bundle`, and `publish`. Atproto OAuth via loopback callback server. The `publish` flow fetches the tarball from the URL, verifies a sha256 multihash, extracts and validates `manifest.json`, locally validates each lexicon record, and atomically writes profile + release records (with the EmDash declaredAccess trust extension) via a single atproto `applyWrites`. Distributes via `npx @emdash-cms/registry-cli` to keep atproto deps out of the core CMS install. Also switches `@emdash-cms/registry-client` and `@emdash-cms/registry-lexicons` from shipping TypeScript source to building to `dist/` via tsdown.
