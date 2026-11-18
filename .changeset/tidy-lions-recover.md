---
"@emdash-cms/sandbox-workerd": patch
---

Fixes `wallTimeMs` timeouts leaving spinning Node.js sandboxed plugins running and blocking later calls. After a timeout, the runner probes the affected plugin's listener for up to 500 ms and force-stops and restarts workerd only if the listener is unresponsive. A responsive plugin waiting on slow I/O does not trigger a restart or interrupt other in-flight calls. When a restart is needed, it interrupts all in-flight plugin calls and resets their in-memory state because plugins share the process.
