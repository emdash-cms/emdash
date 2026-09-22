---
"@emdash-cms/plugin-types": minor
"emdash": minor
"@emdash-cms/cloudflare": minor
"@emdash-cms/sandbox-workerd": minor
"@emdash-cms/plugin-test": minor
"@emdash-cms/plugin-cli": minor
"@emdash-cms/registry-lexicons": minor
"@emdash-cms/admin": minor
---

Adds capability-gated schema, translation, public URL, and content revision discovery for plugins.

Declare `schema:read` to list collection and field definitions through `ctx.schema`. Existing `content:read` access can inspect safe content identity, discover locale siblings with `getTranslations()`, and resolve published routes with `getPublicUrl()`. Public URL resolution follows the site's collection pattern, locale routing, and trailing-slash policy and returns `null` for content without a public route.

Revision snapshots require the separate `content:revisions:read` capability because retained history can contain field values that an administrator removed later. This capability implies ordinary `content:read` access. Installation and plugin updates show both new authorities for consent, and the native, Cloudflare Worker Loader, and Node.js workerd runtimes expose the same methods.
