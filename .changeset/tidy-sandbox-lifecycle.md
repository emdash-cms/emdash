---
"emdash": patch
"@emdash-cms/plugin-test": patch
"@emdash-cms/sandbox-workerd": patch
---

Fixes sandboxed plugins declared in the integration's `sandboxed` config skipping `plugin:install` and `plugin:activate` on first boot. These hooks now run once for plugins without a recorded state, allowing activation hooks to schedule recurring cron tasks without an admin disable/re-enable cycle.

On existing sites, these hooks run on the first start after upgrading for every `sandboxed` plugin without a recorded state, including plugins running with `sandbox: false`. Before upgrading, check that their install hooks are safe to run when settings or plugin data already exist.

Only failures in the plugin's own install or activate hook code disable the plugin. EmDash logs these failures instead of retrying on every start. Sandbox startup failures leave no saved plugin state, so the next boot retries. On Node, workerd and Miniflare readiness is checked before the hook timeout starts. After fixing a hook failure, re-enable the plugin from the Plugins page to run `plugin:activate` again.

`createPluginRuntimeTestHost()` also runs install → activate when creating a host. Tests that explicitly call `actions.plugin.activate()` should account for the initial activation.
