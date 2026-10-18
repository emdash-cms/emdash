---
"emdash": patch
---

Fixes locale-aware queries when Astro locales use custom paths and codes, such as `{ path: "en", codes: ["en-US"] }`. Passing `Astro.currentLocale` to content, menu, taxonomy, and byline queries now matches rows stored under either the configured path or its codes. New writes use the path, while existing code-stamped rows keep their IDs, locale values, and associations. Reapplying seeds using either spelling reuses existing rows instead of creating duplicates.

When both path- and code-stamped rows exist for the same slug or name, lookups and seed matching prefer the path, then codes in configuration order. Public content queries consider only published rows, so a draft path row does not hide a published code row. Existing rows are not merged or deleted: listings retain both, and row-ID lookups remain available. This read-side compatibility avoids a destructive data migration or manual renaming during upgrade.
