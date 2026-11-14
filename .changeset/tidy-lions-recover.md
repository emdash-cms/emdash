---
"@emdash-cms/sandbox-workerd": patch
---

Fixes `wallTimeMs` timeouts leaving Node.js sandboxed plugins running and blocking later calls. A timeout now force-stops workerd and restarts it with the loaded plugins, so subsequent calls can run again. Because plugins share the workerd process, recovery interrupts other in-flight plugin calls and resets their in-memory state.
