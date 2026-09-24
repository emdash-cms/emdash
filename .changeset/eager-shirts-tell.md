---
"emdash": patch
---

Fixes a D1/SQLite performance regression where taxonomy-filtered listings (e.g. `where: { category: "News" }` ordered by `published_at` or `created_at`) read orders of magnitude more rows than necessary. The `picked` CTE now uses a plain `JOIN` so the planner can drive from the content table's deleted-sort index, probe the pivot by primary key, and short-circuit at `LIMIT`, restoring the indexed-sort early-limit behavior.
