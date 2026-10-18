---
"emdash": patch
---

Fixes repeated plugin storage index registration so unchanged declarations no longer rewrite the `_plugin_indexes` registry rows on every sync. This reduces background write traffic on D1 and other SQLite-backed deployments when index declarations have not changed.
