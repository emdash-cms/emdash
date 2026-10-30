---
"emdash": patch
"@emdash-cms/cloudflare": patch
"@emdash-cms/sandbox-workerd": patch
"@emdash-cms/plugin-test": patch
---

Fixes `ctx.kv` values disappearing when a plugin with the same ID moves between `plugins: []` and `sandboxed: []`. **This storage migration requires a coordinated upgrade; it cannot be deployed as a rolling upgrade.**

Both sandbox runners share the in-process KV store. A database migration copies existing non-`settings:` sandbox values and revisions without overwriting in-process values, warns about conflicting plugin IDs and keys, and retains the original sandbox rows for recovery. Uninstalling a marketplace or registry plugin with data deletion removes its shared KV values and settings; failed-install rollback preserves existing data, including partial writes made by an installation hook before it fails. Plugin-test KV fixtures and inspection use the shared store; use the settings inspection API for `settings:` keys.

#### What should I do?

1. Back up the database.
2. Stop all application instances and plugin jobs that write to it.
3. Upgrade `emdash` and your sandbox runner together, then build the site without starting it.
4. Run `pnpm emdash migrate` against the reviewed database target.
5. Resolve conflicting KV copies before plugins can write again.
6. Start or deploy the upgraded site.

Do not rely on default `auto` migrations for this upgrade: they start plugins immediately after migrating, leaving no conflict-review window. Mixed package versions are not automatically rejected. See the [plugin upgrade guide](https://docs.emdashcms.com/plugins/upgrading-sites/#plugin-kv-storage-when-changing-execution-mode) for target selection, recovery queries, and rollback instructions. Downgrading packages alone hides post-upgrade KV writes; restoring the pre-upgrade database backup discards all site changes made since it was taken.
