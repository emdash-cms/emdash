---
"emdash": patch
---

Fixes unsaved inline (visual) editor changes being silently lost when navigating away, e.g. via the browser back button. Edits are now flushed with a keepalive request when the page unloads.
