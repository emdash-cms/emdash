---
"emdash": patch
"@emdash-cms/plugin-test": patch
"@emdash-cms/sandbox-workerd": patch
---

Fixes sandboxed plugins declared in the integration's `sandboxed` config skipping `plugin:install` and `plugin:activate` on first boot. These hooks run for plugins without a recorded state, allowing activation hooks to schedule recurring cron tasks without an admin disable/re-enable cycle. Successful initialization is recorded so later boots do not replay the hooks.

On existing sites, these hooks run on the first start after upgrading for every `sandboxed` plugin without a recorded state, including plugins running with `sandbox: false`. Before upgrading, check that their install hooks are safe to run when settings or plugin data already exist.

During first-boot setup, only failures in the plugin's own install or activate hook code disable the plugin. EmDash logs these failures instead of retrying on every start. Sandbox startup failures leave no saved plugin state, so the next boot retries. If the sandbox becomes unavailable after install succeeds, the next boot runs install again as well as activate; make install hooks idempotent. On Node, workerd and Miniflare readiness is checked before the hook timeout starts. Each new boot can delay its first request on a readiness attempt while the sandbox remains unavailable. After fixing a hook failure, re-enable the plugin from the Plugins page to run `plugin:activate` again.

`createPluginRuntimeTestHost()` also runs install → activate when creating a host, before test fixtures are added. A failure in the plugin's own lifecycle hook disables it in the test host, so later actions will not invoke its hooks. Tests that explicitly call `actions.plugin.activate()` should account for the initial activation.
