---
"emdash": minor
---

`<EmDashHead>` now applies the entry's SEO panel values (title, description, image, canonical, noindex) automatically on content pages. Editor-set panel values override template-provided metadata, while plugin contributions still take precedence. Previously the panel was silently ignored unless the page wired `getSeoMeta()` by hand. The `<title>` element remains the template's responsibility.
