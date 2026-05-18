---
"emdash": patch
---

Fixes two data-loss bugs in the WordPress WXR import path (admin UI Settings, Import, WordPress, i.e. `POST /_emdash/api/import/wordpress/execute`).

Per-post taxonomy assignments parsed from `<wp:category>`, `<wp:tag>`, `<wp:term>`, and per-item `<category domain="...">` blocks (#1061) are now persisted. The HTTP execute handler previously extracted this data and silently discarded it before any taxonomy or pivot rows were written. Terms are created idempotently in EmDash's seeded `category` and `tag` taxonomies; custom taxonomies such as `genre` are matched against existing EmDash definitions via the runtime's locale fallback chain (`resolveLocaleChain`), so imports against a non-default-locale site reuse defs seeded at the default locale instead of false-failing. Unknown custom taxonomies surface in a new `result.taxonomies.missingTaxonomies` field instead of being silently dropped, so the admin can prompt the user to create the missing definition. Assignments respect each taxonomy definition's `collections` array.

WPML and Polylang translations (#1080) are now imported under their own per-post locale and linked via `translation_group`. Previously the entire upload shared one `config.locale` and the second post of any translation pair was rejected by the `UNIQUE(slug, locale)` constraint introduced in migration 019. The parser promotes per-post locale from `_icl_lang_code` (WPML), `trid` (WPML's translation group id), `_locale` (Polylang), the `language` taxonomy, or `_translations` postmeta. Terms are mirrored into each translation's locale so per-locale lookups (`getTermsForEntry(..., locale)`) resolve correctly on every translation row. Per-translation taxonomy assignments override anchor-inherited ones per-taxonomy when the translator picked different terms, matching WPML "Translate Independently" mode. Taxonomies the translation did not touch keep their inherited assignments, matching WPML "Sync" mode and Polylang's default.

Adds `result.taxonomies` to the import response (additive). Existing consumers continue to work unchanged.

Scope note: this fixes the HTTP import path, which is what the admin UI calls. The standalone `emdash import wordpress` CLI command writes JSON files to disk and has its own slug-only output path that does not carry locale, so it can still clobber two translations with the same `post_name`. That is a separate fix and not addressed here.
