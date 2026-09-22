---
"emdash": minor
"@emdash-cms/cloudflare": patch
"@emdash-cms/sandbox-workerd": patch
"@emdash-cms/plugin-test": minor
"@emdash-cms/plugin-cli": patch
---

Adds translation-aware sandboxed plugin content creation through `ctx.content.create(collection, data, { locale, translationOf })`.

The source must be an active entry in the same collection. The new entry joins its translation group, inherits its byline credits and taxonomy assignments, and takes non-translatable field values from the source. Content validation and save hooks run in both the Cloudflare Worker Loader and Node/workerd runners. Save-hook-originated creates do not re-enter save hooks, and the creating plugin's own `content:afterSave` hook is not re-entered.

Each translation group permits one active entry per locale. Duplicate locale creates return `CONFLICT`, missing sources return `NOT_FOUND`, invalid or unconfigured locales return `VALIDATION_ERROR`, and save hooks can return `SAVE_REJECTED`.
