---
"emdash": patch
---

Allow hyphens in collection, field, and taxonomy slugs. EmDash slug validation now accepts `[a-z][a-z0-9_-]*` instead of `[a-z][a-z0-9_]*`. This fixes WordPress import crashes (#79) where plugins register post types with hyphens (e.g. `elementor-hf`, `shop-order`) by accepting them natively rather than sanitizing to underscores.
