---
"@emdash-cms/plugin-test": minor
"emdash": minor
"@emdash-cms/cloudflare": patch
"@emdash-cms/plugin-cli": patch
---

Adds `createPluginRuntimeTestHost()` for sandboxed plugin tests that must exercise EmDash orchestration instead of invoking an isolate directly. The host separates direct transport calls, fixtures, production actions, observable-state inspectors, scheduled time control, cold restart, and disposal.

Runtime actions cover the shipped content lifecycle, plugin activation and deactivation, media upload, public comment submission, comment moderation, plugin-route policy, and scheduled task execution. The controlled scheduler clock applies to cron tasks and scheduled publishing. `restart()` retains D1, plugin storage, media storage, and plugin state while replacing runtime and isolate memory. The host captures delivered email for assertions.

`createPluginTestHost()` and its top-level `invokeHook()` and `invokeRoute()` methods remain compatible for fast transport-level tests. `emdashPluginTest()` supplies the runtime modules required by the documented Vitest configuration. Generated plugin projects continue to use Worker Loader by default and describe Node/workerd parity as an opt-in test for runner-sensitive behavior.
