---
"emdash": patch
---

Fixes the WordPress export file (WXR) import in the admin keeping links to the old WordPress domain in imported content. Links to the source site are now rewritten to root-relative paths. The WordPress permalink structure is kept (for example `/2024/05/my-post/`), so add redirects if your routes differ. Links to uploaded files stay absolute, including in raw HTML blocks, which the WordPress plugin import previously turned into broken relative `/wp-content/` links. Links inside reusable blocks imported as sections are not changed.

The import analysis now also shows the real site title and address instead of a generic "WordPress Site" heading. For programmatic use, `parseWxrString` now returns the export's site metadata (it was always empty before), and content fetched through `wxrSource` gets the same link rewriting.
