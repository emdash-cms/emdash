---
"@emdash-cms/sandbox-workerd": patch
---

Fixes sandboxed plugins failing to start when multiple EmDash sites run on the same host. Plugin listeners now use operating-system-assigned ports instead of a fixed port range, with no configuration needed. Failed starts respect restart backoff. Once the retry budget is exhausted, restart the server or install or update a plugin to retry sandboxed plugins. Startup failures report sandbox unavailability to callers while workerd's diagnostics appear in the server log.
