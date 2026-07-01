---
"emdash": minor
---

Updates EmDashHead JSON-LD rendering for Astro CSP compatibility.

Sites using `<EmDashHead />` do not need to change anything. JSON-LD structured data is still rendered automatically, but EmDash now registers the generated script hashes with Astro's CSP runtime API so strict CSP can allow them.

This also adds `renderPageMetadata(metadata, { includeJsonLd: false })` for advanced integrations that render metadata manually and want to handle JSON-LD script tags themselves. The default remains unchanged: calling `renderPageMetadata(metadata)` still includes JSON-LD script tags in the returned HTML string.
