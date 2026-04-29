---
"emdash": patch
---

Fixes migration `035_bounded_404_log` failing with `UNIQUE constraint failed: _emdash_404_log.path` when re-run after a partial first attempt. The dedup step was gated on `if (!hitsExists)`, so any retry that already had the `hits` column committed would skip dedup and crash on the unique-index creation. Gate dedup on the absence of the unique index instead, which is the actual invariant the index needs.
