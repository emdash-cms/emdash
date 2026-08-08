---
"emdash": patch
---

Fixes sites that don't use bylines paying dead byline lookup queries on every content read. When the bylines table is empty, entries with an author no longer send hydration down the byline query path — the folded result is served directly, removing the wasted round trips from anonymous page renders.
