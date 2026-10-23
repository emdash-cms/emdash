---
"emdash": patch
"@emdash-cms/plugin-test": patch
---

Fixes sandboxed plugins declared in the integration's `sandboxed` config skipping `plugin:install` and `plugin:activate` on first boot. These hooks now run once for plugins without a recorded state, allowing activation hooks to schedule recurring cron tasks without an admin disable/re-enable cycle.

On existing sites, these hooks run on the first start after upgrading for every `sandboxed` plugin without a recorded state, including plugins running with `sandbox: false`. Before upgrading, check that their install hooks are safe to run when settings or plugin data already exist.

If either hook fails, EmDash logs the error and disables the plugin instead of retrying on every start. This includes sandbox invocation failures. After fixing the problem, re-enable the plugin from the Plugins page to run `plugin:activate` again.

`createPluginRuntimeTestHost()` also runs install → activate when creating a host. Tests that explicitly call `actions.plugin.activate()` should account for the initial activation.
