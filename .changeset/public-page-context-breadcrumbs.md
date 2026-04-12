---
"emdash": minor
---

Adds `breadcrumbs?: BreadcrumbItem[]` to `PublicPageContext` so themes can publish a breadcrumb trail as part of the page context, and SEO plugins (or any other `page:metadata` consumer) can read it without having to invent their own per-theme override mechanism. `BreadcrumbItem` is also exported from the `emdash` package root. The field is optional and non-breaking — existing themes and plugins work unchanged, and consumers can adopt it incrementally. Empty array (`breadcrumbs: []`) is an explicit opt-out signal (e.g. for homepages); `undefined` means "no opinion, fall back to consumer's own derivation".
