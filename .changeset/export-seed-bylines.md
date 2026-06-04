---
"emdash": patch
---

Fix `emdash export-seed` omitting bylines. The exporter now emits byline profiles as the root `bylines[]` array (one entry per translation group, since `SeedByline` has no locale axis) and, when content is exported, attaches each entry's ordered byline credits as `bylines[]` referencing those profiles. Credits are read straight from `_emdash_content_bylines` (whose `byline_id` already stores the translation group), so the exported seed round-trips back through `applySeed` with profiles and credits intact.
