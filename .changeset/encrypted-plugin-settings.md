---
"emdash": minor
"@emdash-cms/cloudflare": minor
"@emdash-cms/sandbox-workerd": minor
"@emdash-cms/plugin-test": minor
"@emdash-cms/plugin-cli": patch
---

Adds `ctx.settings` for plugin configuration and encrypts fields declared as `type: "secret"` before writing them to the database. Native plugins, Cloudflare Worker Loader plugins, and Node/workerd plugins share the same versioned AES-GCM envelope and plugin-scoped API. `@emdash-cms/plugin-test` can update generated settings through the runtime host and inspect their raw persisted envelope.

Set `EMDASH_ENCRYPTION_KEY` in the runtime process environment before saving secret settings. A standalone Node server does not load `.env` automatically. To rotate the key, place the new key first in a comma-separated list and retain old keys until every plugin secret has been saved again. EmDash does not currently report which key IDs remain in use, so track each resaved credential and verify its integration before removing an old key. Restores need both the database and every encryption key referenced by its stored envelopes.

Cloudflare sites using `nodejs_compat` with a compatibility date before `2025-04-01` must also add `nodejs_compat_populate_process_env` before saving secrets through the generated admin form. Cloudflare enables that behavior by default for later compatibility dates.

Existing plaintext secrets remain readable and are encrypted when saved again. The `ctx.kv.get("settings:<key>")` compatibility alias remains available throughout the EmDash 0.x release line; new plugin code should use `ctx.settings.get("<key>")`.

Only fields declared as `type: "secret"` in `admin.settingsSchema` use this encryption path. Arbitrary plugin KV and state values are unchanged; credentials stored by the bundled AT Protocol and webhook notifier plugins are not migrated by this release.
