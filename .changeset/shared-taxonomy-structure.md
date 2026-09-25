---
"emdash": minor
"@emdash-cms/plugin-test": patch
---

Updates taxonomy definitions so `hierarchical` and `collections` belong to the taxonomy instead of to each locale. Every locale reads the same values, and translations can no longer disagree about whether a taxonomy is hierarchical or which collections it applies to. `label` and `labelSingular` stay per locale.

This changes behavior for multilingual sites:

- `PUT /_emdash/api/taxonomies/{name}` and the MCP `taxonomy_update` tool change `hierarchical` and `collections` for every locale, even when `locale` is passed. Previously they changed only the addressed locale's definition.
- Creating a definition for a name that already exists in another locale joins that taxonomy, with or without `translationOf`, instead of starting a separate translation group. It takes the taxonomy's `hierarchical` and `collections`; a create that sends different values returns `VALIDATION_ERROR`, where it previously stored them for the new locale only. Change them with an update instead.
- `getTaxonomyTerms()`, `getTaxonomyDef()` and `getTaxonomyDefs()` return a taxonomy in every locale, including a locale without its own definition, which takes its label from the first locale on its fallback chain that has one, else the default locale, else the lowest locale code. Previously such a locale got no definition and an empty term list, so the built-in Categories and Tags widgets rendered empty on sites whose default locale had no definition.
- Seed files may omit `hierarchical` and `collections` on a taxonomy entry whose `translationOf` points at an entry with the same `name`. Applying a seed follows `translationOf` through entries with the same `name` and takes them from the last one, whatever the translations carry and wherever the entries appear in the file. Validation warns when a translation declares values other than the ones it takes, or when two entries that declare them for one taxonomy disagree. The exported `SeedTaxonomy` type marks both fields optional, so code that reads them from a seed must handle `undefined`. `emdash export-seed` writes them only on the entry the translations point at.
- Importing a WordPress export (WXR) into a locale assigns the terms of a taxonomy that is defined only in another locale. Previously the import skipped them and reported the taxonomy as missing.

The upgrade migration merges existing definitions of each taxonomy name into one. Where locales disagreed, the taxonomy becomes hierarchical if any locale's definition was, and applies to every collection any locale's definition listed, so no term tree flattens and no collection loses a taxonomy it showed in some locale. Definitions of one name that were in separate translation groups are joined into one group. Definitions of different names that shared a translation group, which older seed files and API versions could create, get one group per name.

#### What should I do?

If your site defines different `hierarchical` or `collections` values per locale on purpose, check them after upgrading and set the values you want once.

If your code changes `hierarchical` or `collections` by writing to `_emdash_taxonomy_defs` with SQL, use the taxonomy API, the MCP `taxonomy_update` tool or a seed file instead. A direct write no longer changes what EmDash reads, only what sandboxed plugins see. EmDash still updates those columns whenever a taxonomy changes, for code that reads them.

`@emdash-cms/plugin-test`: `runtimeHost.fixtures.taxonomyDefinition()` sets `hierarchical` and `collections` for every locale of the taxonomy.
