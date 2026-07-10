---
"emdash": patch
---

Adds hreflang alternate links to the page head for translated content. `<EmDashHead>` now emits a `<link rel="alternate" hreflang="...">` per published translation (plus `x-default`) automatically, and a new `getHreflangAlternates()` helper resolves the same set for hand-rolled heads.
