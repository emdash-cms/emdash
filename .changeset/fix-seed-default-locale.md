---
"emdash": patch
---

Fix seed CLI hardcoding `en` as the default locale (#1421)

`emdash export-seed` now emits a top-level `defaultLocale` for single-locale
projects, and `emdash seed` (`applySeed`) honors it when backfilling the locale
of menus, taxonomies, and content rows that omit an explicit `locale`. Previously
an `export-seed` → `seed` round-trip silently rewrote a non-`en` default locale
(e.g. `de`) to `en`, since the CLI runs outside the Astro runtime and the
fallback collapsed to `en`. Projects whose default locale is `en` are unaffected.
