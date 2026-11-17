---
"@emdash-cms/sandbox-workerd": patch
---

Fixes production workerd sandboxes outliving their Node.js host and holding plugin ports open. On Linux and macOS, sandboxes now stop when the host exits, including after SIGKILL when `/bin/sh` is available. SIGTERM and SIGINT preserve the host's default exit when no application handler is registered. When an application handles either signal, sandboxes stay available while requests drain without preventing the host from exiting naturally.
