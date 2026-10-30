---
"emdash": patch
"@emdash-cms/plugin-test": patch
"@emdash-cms/sandbox-workerd": patch
---

Fixes config-declared sandboxed plugins, including those running with `sandbox: false`, skipping `plugin:install` and `plugin:activate` on first boot. These hooks now run for plugins without a recorded state, including on the first start after upgrading, so activation hooks can set up recurring tasks without an admin disable/re-enable cycle.

If a sandbox stops before setup finishes, `plugin:install` can run again on the next boot. Make install hooks safe to repeat when settings or plugin data already exist.

`createPluginRuntimeTestHost()` also runs install → activate when creating a host, before test fixtures are added. A failure in the plugin's own lifecycle hook disables it in the test host, so later actions will not invoke its hooks. Tests that explicitly call `actions.plugin.activate()` should account for the initial activation.

#### What should I do?

Make install hooks set only missing values. If a plugin hook failed, fix the hook and re-enable the plugin from the Plugins page to run `plugin:activate` again.
