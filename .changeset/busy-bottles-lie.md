---
"@emdash-cms/sandbox-workerd": patch
---

Fixes workerd processes surviving their Node.js host on Linux and macOS, including after SIGKILL when `/bin/sh` is available, and keeping plugin ports open. SIGTERM and SIGINT now stop the sandbox without suppressing the host's default exit behavior or application signal handlers.
