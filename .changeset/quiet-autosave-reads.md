---
"emdash": patch
---

Speeds up content saves, including admin autosave, on collections with revisions. Also fixes a save with a stale `_rev` that could store its draft over a schedule or unschedule landing at the same moment; it now returns `CONFLICT`.
