---
"emdash": minor
---

`<EmDashHead>` now applies the entry's SEO panel values (title, description, image, canonical, noindex) automatically on server-rendered content pages. Previously the panel was silently ignored unless the page wired `getSeoMeta()` by hand.

#### Affected pages

Pages that include `<EmDashHead>` and fetch their entry through `getEmDashEntry()` — or the EmDash live collection directly — receive the overlay. This includes warm object-cache hits, because `getEmDashEntry()` primes the same request-scoped cache from the cached snapshot when the loader never runs.

#### What editors can override

Editor-set panel values replace the template-provided base fields for `description`, `og:title`, `og:description`, `og:image`, the canonical URL, and robots. They also feed the JSON-LD structured data, so head tags and structured data stay in sync.

#### What plugins see

Plugin `page:metadata` and `page:fragments` hooks — in the head and in the body components — receive the overlaid page context, but plugin contributions still win via first-wins dedup.

#### What does not change

- The `<title>` element remains the template's responsibility.
- Prerendered pages and pages that bypass `<EmDashHead>` keep using `getSeoMeta()`.
- No additional database query is made; the panel data rides along on the entry query the page already runs.
