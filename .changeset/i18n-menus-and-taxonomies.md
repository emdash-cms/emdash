---
"emdash": minor
---

Adds i18n support to menus and taxonomies (categories, tags, custom
definitions), mirroring the per-locale model already in place for content.
Each row carries `locale` and `translation_group`; translations of the
same menu/term/def share a `translation_group`. `_emdash_menu_items.reference_id`
and `content_taxonomies.taxonomy_id` are remapped to store the referenced
row's translation_group, so a single association survives content
translations and is resolved against the active locale at runtime.

- Runtime helpers (`getMenu`, `getTaxonomyTerms`, `getTerm`, `getEntryTerms`,
  `getAllTermsForEntries`, …) accept an optional `{ locale }` and honour the
  i18n fallback chain; when no locale is given they fall back to the
  request context and `defaultLocale`, matching `getEmDashCollection` /
  `getEmDashEntry`.
- REST API: GET endpoints accept `?locale=xx`; POST endpoints accept
  `locale` and `translationOf` in their bodies. New endpoints:
  `GET/POST /_emdash/api/menus/:name/translations` and
  `GET/POST /_emdash/api/taxonomies/:name/terms/:slug/translations`.
- Creating a content translation now auto-copies the source's taxonomy
  assignments (the pivot is locale-agnostic, so the copied rows apply to
  the whole translation group).
- MCP: `taxonomy_list`, `taxonomy_list_terms`, `taxonomy_create_term`,
  `menu_list`, `menu_get` accept `locale`. New tools:
  `taxonomy_term_translations`, `menu_translations`.
- Admin: `TaxonomyManager` and `MenuList` surface a `LocaleSwitcher` when
  multiple locales are configured and thread the active locale through
  all API calls. `TaxonomyManager` exposes a "Translate" action per term
  that creates the translation and switches to the new locale.

No breaking changes for new installs or single-locale upgrades — defaults
are additive (locale defaults to `'en'` when omitted, reproducing pre-i18n
behaviour).

> ⚠️ **Rolling back migration `036_i18n_menus_and_taxonomies` is blocked
> on multi-locale installs.** Dropping the `locale` column would collapse
> translated rows onto an ambiguous `(name, slug)` unique key, silently
> deleting content. The migration's `down()` now refuses to run when any
> row uses a non-default locale and prints the affected table in the
> error. If you need to revert, export translations first (or delete
> them), then re-run the rollback. Single-locale installs revert cleanly.
