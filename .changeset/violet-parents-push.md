---
"emdash": patch
"@emdash-cms/cloudflare": patch
"@emdash-cms/sandbox-workerd": patch
"@emdash-cms/plugin-test": patch
---

Fixes `ctx.kv` values disappearing when a plugin with the same ID moves between `plugins: []` and `sandboxed: []`. Both sandbox runners share the in-process KV store, and a database migration copies existing non-`settings:` sandbox values and revisions without overwriting in-process values. Original sandbox rows are retained for recovery. The migration warns about conflicting plugin IDs and keys so you can review which copy to keep before resuming writes.

Uninstalling a marketplace or registry plugin with data deletion also removes its shared KV values and settings. Plugin-test KV fixtures and inspection use the shared store; use the settings inspection API for `settings:` keys.

Upgrade `emdash` and your sandbox runner together with all writers stopped. Build the upgraded site, run `pnpm emdash migrate` against the reviewed database target, and resolve conflicts before starting or deploying the application. Default `auto` migrations start plugins immediately afterward, so they do not provide a conflict-review window. Mixed package versions are not automatically rejected. See the [plugin upgrade guide](https://docs.emdashcms.com/plugins/upgrading-sites/#plugin-kv-storage-when-changing-execution-mode) for conflict recovery queries and rollout details. To downgrade safely, restore the pre-upgrade database backup along with the older packages; downgrading packages alone hides post-upgrade KV writes. Restoring the backup discards all site changes made since it was taken.
