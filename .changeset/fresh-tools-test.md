---
"@emdash-cms/plugin-test": minor
"@emdash-cms/plugin-cli": minor
---

Adds a workerd-backed Vitest host for sandboxed plugin tests and includes it in projects created by `emdash-plugin init`. `emdashPluginTest()` builds the plugin and configures D1, Worker Loader, and the production `PluginBridge`; `createPluginTestHost()` invokes hooks and routes through the production sandbox boundary and provides helpers for content fixtures, plugin storage, and KV assertions.
