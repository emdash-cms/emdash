---
"emdash": minor
"@emdash-cms/cloudflare": patch
"@emdash-cms/sandbox-workerd": patch
---

Adds the cause to the `SANDBOX_NOT_AVAILABLE` error and to the "Plugin sandbox is configured but not available on this platform" startup warning when a configured sandbox runner cannot run plugins. On Cloudflare Workers the message names the missing `worker_loaders` binding or `PluginBridge` export; on Node.js it says that the `workerd` binary did not run.

Sandbox runners report the cause through a new optional `unavailableReason()` method on `SandboxRunner`. Runners without it keep the previous messages.
