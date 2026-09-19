---
"emdash": patch
---

Fixes media usage tracking ignoring images inside Portable Text gallery blocks. A media item used only in galleries showed an empty "Used in" list and looked unused; gallery images are now indexed as `portable_text_image` references with a field path into the gallery (`body[3].images[0].asset._ref`). Indexes written before this fix are now reported as stale rather than complete, so gallery-only media no longer looks safe to delete until those indexes are rebuilt.
