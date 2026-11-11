---
"@emdash-cms/sandbox-workerd": patch
---

Fixes production workerd sandboxes outliving their Node.js host and holding plugin ports open. On Linux and macOS, sandboxes now stop when the host exits, including after SIGKILL when `/bin/sh` is available. SIGTERM and SIGINT stop the sandbox without suppressing the host's default exit or application signal handlers.
