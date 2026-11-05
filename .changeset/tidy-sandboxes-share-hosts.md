---
"@emdash-cms/sandbox-workerd": patch
---

Fixes sandboxed plugins failing to start when multiple EmDash sites run on the same host. Plugin listeners now use operating-system-assigned ports instead of a fixed port range, with no configuration needed. Startup errors also include workerd's diagnostic output instead of only a generic readiness timeout.
