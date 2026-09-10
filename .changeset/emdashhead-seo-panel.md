---
"emdash": minor
---

`<EmDashHead>` now applies the entry's SEO panel values (title, description, image, canonical, noindex) automatically on server-rendered content pages. Previously the panel was silently ignored unless the page wired `getSeoMeta()` by hand.

#### Affected pages

Pages that include `<EmDashHead>` and fetch their entry through `getEmDashEntry()` receive the overlay. This includes warm object-cache hits, because `getEmDashEntry()` primes the same request-scoped cache from the cached snapshot when the loader never runs. Multi-entry collection results (e.g. `getEmDashCollection()`) are not currently covered.

#### What editors can override

Editor-set panel values replace the template-provided base fields for `description`, `og:title`, `og:description`, `og:image`, the canonical URL, and robots. They also feed the JSON-LD structured data, so head tags and structured data stay in sync.

#### What plugins see

Plugin `page:metadata` and `page:fragments` hooks — in the head and in the body components — receive the overlaid page context, but plugin contributions still win via first-wins dedup.

#### What does not change

- The `<title>` element remains the template's responsibility.
- Prerendered pages and pages that bypass `<EmDashHead>` keep using `getSeoMeta()`.
- No additional database query is made; the panel data rides along on the entry query the page already runs.

#### Canonical and image URL resolution

`getSeoMeta()` now resolves an explicit SEO panel canonical through the same resolver as `<EmDashHead>`: root-relative values (`/custom-path`) are absolutized against the site URL when one is configured (previously they were returned unchanged), and protocol-relative values (`//host/path`) pass through untouched. The same panel value now produces the same canonical URL on both paths.

Protocol-relative SEO image references (`//cdn.example.com/x.png`) are no longer prefixed with the site URL, which previously produced a broken doubled-path URL. This corrects `og:image` output everywhere the panel image is resolved: the `<EmDashHead>` overlay, `getSeoMeta()`, and image URLs in the sitemap.
