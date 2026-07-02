---
"emdash": minor
"@emdash-cms/cloudflare": minor
"@emdash-cms/sandbox-workerd": minor
---

Adds read-only taxonomy access to the plugin content API: plugins with `content:read` can now list taxonomy definitions, fetch the terms of a taxonomy, and read the terms assigned to a content entry via `ctx.content.getTaxonomies()`, `ctx.content.getTaxonomyTerms()`, and `ctx.content.getEntryTerms()` — in-process and in both sandbox runners.
