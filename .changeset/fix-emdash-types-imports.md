---
"emdash": patch
---

Fixes `emdash types` so the generated `.emdash/types.ts` imports `BylineSummary`, `ContentBylineCredit`, and `TaxonomyTerm` alongside `PortableTextBlock`.

Previously the CLI downloaded TypeScript definitions whose collection interfaces referenced these three names but only imported `PortableTextBlock`, causing `tsc` to report `TS2304` errors for every collection.
