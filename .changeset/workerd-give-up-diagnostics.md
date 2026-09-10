---
"@emdash-cms/sandbox-workerd": patch
---

Fixes the workerd plugin sandbox logging `Plugins will run unsandboxed` after it stops restarting a repeatedly crashing `workerd`, when in fact every sandboxed hook and route fails from that point. The log line now names that consequence, and the reason on `SandboxUnavailableError` distinguishes a spent crash budget from a runner that never started.
