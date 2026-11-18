---
"@emdash-cms/sandbox-workerd": patch
---

Fixes `wallTimeMs` timeouts leaving runaway Node.js sandboxed plugin invocations executing after their callers fail. After a timeout, the runner probes the affected plugin's listener for up to 500 ms and force-stops and restarts workerd if the listener is unresponsive or the invocation remains unsettled for one additional `wallTimeMs` interval. This stops yielding loops and slow I/O that later enters a CPU loop, while responsive handlers that settle within the grace period leave other plugins' calls running. Restarts interrupt all in-flight plugin calls and reset their in-memory state because plugins share the process.
