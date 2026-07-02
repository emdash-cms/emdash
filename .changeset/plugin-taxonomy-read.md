---
"emdash": minor
"@emdash-cms/cloudflare": minor
"@emdash-cms/sandbox-workerd": minor
"@emdash-cms/plugin-types": minor
"@emdash-cms/plugin-cli": minor
"@emdash-cms/registry-lexicons": minor
"@emdash-cms/admin": patch
---

Adds a `taxonomies:read` plugin capability with read-only taxonomy access: plugins that declare it get `ctx.taxonomies` to list taxonomy definitions (`getAll()`), fetch the terms of a taxonomy (`getTerms()`), and read the terms assigned to a content entry (`getEntryTerms()`) — in-process and in both sandbox runners.
