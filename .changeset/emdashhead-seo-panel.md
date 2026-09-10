---
"emdash": minor
---

`<EmDashHead>` now applies the entry's SEO panel values (title, description, image, canonical, noindex) automatically on content pages whose entry was fetched through `getEmDashEntry()` or a live content collection in the same request, including entries served from the object cache. Editor-set panel values override template-provided metadata, while plugin contributions still take precedence, and structured data stays consistent with the head tags. Plugin `page:metadata` and `page:fragments` hooks — in the head and in the body components — receive the overlaid page context, so hook-rendered output agrees with the rendered metadata. Previously the panel was silently ignored unless the page wired `getSeoMeta()` by hand. The panel data rides along on the entry query the page already runs, so no additional database query is made. The `<title>` element remains the template's responsibility, and prerendered pages keep using `getSeoMeta()`.
