---
"emdash": patch
---

Reduces the D1 query footprint of `POST /_emdash/api/import/wordpress/execute` and adds a chunked import mode for large WXR files:

- Per-request caching of collection SEO metadata and datetime normalization contexts, so repeated `handleContentCreate` calls inside one import do not re-query `_emdash_collections`/`_emdash_fields` for every post.
- Batched taxonomy term resolution: `preImportWxrTaxonomies` resolves declared WXR categories/tags/terms in a small number of batched SELECTs instead of one `findBySlug` per term.
- Optional chunked import via `phase=content`, `cursor`, and `chunk` form fields. Each Worker invocation processes at most 30 posts and returns a resumable cursor, keeping imports under the D1 per-invocation query limit.
- Single-shot imports that exceed the 30-post budget now fail fast with a `WXR_IMPORT_TOO_LARGE` error instead of hanging mid-import.
