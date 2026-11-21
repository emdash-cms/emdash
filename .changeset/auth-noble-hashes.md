---
"emdash": patch
"@emdash-cms/auth": patch
"@emdash-cms/plugin-cli": patch
---

Removes the deprecated `arctic` package and moves all hashing outside passkeys from `@oslojs/crypto` to `@noble/hashes`, so installing `emdash` no longer prints the `arctic` and `@oslojs/jwt` deprecation warnings and installing `@emdash-cms/plugin-cli` no longer prints the `@oslojs` ones. Hashes come out exactly as before, so existing API tokens, pending invites and magic links, encryption keys and plugin storage indexes keep working.
