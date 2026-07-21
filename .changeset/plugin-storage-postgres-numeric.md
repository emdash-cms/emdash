---
"emdash": patch
---

fix(core): compare plugin-storage numeric filters and ordering numerically on Postgres. `_plugin_storage.data` is a `text` column, so after the `::jsonb` cast (#1898) the extracted value is still text and numeric guards compared lexically — `{ stock: { gte: 10 } }` over 9/10/100 matched 9 (over-count/oversell) and numeric `orderBy` sorted `[10, 100, 9]`. Numeric comparisons now use a type-guarded `::numeric` cast and ordering uses the jsonb-native value, so results are numeric and parity-correct with SQLite. Non-numeric stored values yield no match instead of erroring.
