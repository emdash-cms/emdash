---
"emdash": patch
---

Fixes two data-loss bugs in WordPress WXR imports.

Per-post taxonomy assignments parsed from `<wp:category>`, `<wp:tag>`, `<wp:term>`, and per-item `<category domain="…">` blocks (#1061) are now persisted. The HTTP execute handler previously extracted this data and silently discarded it before any taxonomy or pivot rows were written. Terms are created idempotently in EmDash's seeded `category` / `tag` taxonomies; custom taxonomies (`genre`, etc.) are matched against existing EmDash definitions. Unknown custom taxonomies surface in a new `result.taxonomies.missingTaxonomies` field instead of being silently dropped, so the admin can prompt the user to create the missing definition. Assignments respect each taxonomy definition's `collections` array.

WPML and Polylang translations (#1080) are now imported under their own per-post locale and linked via `translation_group`. Previously the entire upload shared one `config.locale` and the second post of any translation pair was rejected by the `UNIQUE(slug, locale)` constraint introduced in migration 019. The parser promotes per-post locale from `_icl_lang_code` (WPML), `trid` / `_icl_translation_id`, `_locale` (Polylang), the `language` taxonomy, or `_translations` postmeta. Terms are mirrored into each translation's locale so per-locale lookups (`getTermsForEntry(..., locale)`) resolve correctly on every translation row. Per-translation taxonomy assignments override anchor-inherited ones when the translator picked different terms (matches WPML "Translate Independently" mode); translations without their own assignments fall through with the inherited set intact (matches WPML "Sync" mode and Polylang's default).

Adds `result.taxonomies` to the import response (additive). Existing consumers continue to work unchanged.
