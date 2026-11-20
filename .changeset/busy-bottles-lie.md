---
"@emdash-cms/sandbox-workerd": patch
---

Fixes production workerd sandboxes outliving their Node.js host and holding plugin ports open. On Linux and macOS, sandboxes now stop when the host exits, including after SIGKILL when `/bin/sh` is available. SIGTERM and SIGINT preserve the host's default exit when no application handler is registered. With `/bin/sh` available, application handlers can drain plugin requests without sandbox resources holding the host open. On shell-less POSIX hosts, sandboxes stop immediately on either signal to avoid orphaning workerd if an application handler re-raises it; host SIGKILL cleanup remains unavailable.

Cleanup also works when Node.js runs as PID 1, such as in Docker containers.
