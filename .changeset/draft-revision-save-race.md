---
"emdash": patch
---

Fixes a race where two saves to the same draft (e.g. an autosave firing just before or after a manual save) could silently discard one of the edits. The losing save now retries against the latest draft instead of overwriting it.
