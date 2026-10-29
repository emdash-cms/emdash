---
"emdash": patch
"@emdash-cms/plugin-test": patch
"@emdash-cms/sandbox-workerd": patch
---

Fixes sandboxed plugins declared in the integration's `sandboxed` config skipping `plugin:install` and `plugin:activate` on first boot. These hooks run for plugins without a recorded state, allowing activation hooks to schedule recurring cron tasks without an admin disable/re-enable cycle. Successful initialization is recorded so later boots do not replay the hooks.

On existing sites, these hooks run on the first start after upgrading for every `sandboxed` plugin without a recorded state, including plugins running with `sandbox: false`. Before upgrading, check that their install hooks are safe to run when settings or plugin data already exist.

Failures returned by a plugin's own install or activate hook code disable the plugin rather than retrying on every start. EmDash logs the error. After fixing a hook failure, re-enable the plugin from the Plugins page to run `plugin:activate` again.

On Node, EmDash waits for the workerd or Miniflare sandbox to be ready before the hook timeout starts. A readiness failure, `SandboxUnavailableError`, or a hook timeout while the runner reports itself unhealthy leaves no saved plugin state, so the next boot retries. Other invocation failures, including Cloudflare Worker Loader startup errors and hook timeouts while the runner reports itself healthy, can still disable the plugin.

A lost connection does not prove that earlier hook writes were rolled back. If the sandbox becomes unavailable after install succeeds, the next boot runs install again as well as activate; make install hooks idempotent. Each new boot can delay its first request on a readiness attempt while the sandbox remains unavailable.

`createPluginRuntimeTestHost()` also runs install → activate when creating a host, before test fixtures are added. A failure in the plugin's own lifecycle hook disables it in the test host, so later actions will not invoke its hooks. Tests that explicitly call `actions.plugin.activate()` should account for the initial activation.
