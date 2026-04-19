---
"emdash": patch
---

Two query-count reductions on the request hot path:

- **Widget areas now fetch in a single query.** `getWidgetArea(name)` used to do two round-trips — one for the area, one for its widgets. Single left-join now. Saves one query per `<WidgetArea>` rendered on a page.
- **Dropped the "has any bylines / has any term assignments" probes.** Those fired on every hydration call to save a single query on sites with zero bylines/terms — exactly the wrong tradeoff. The batch hydration queries already handle empty sites at the same cost, so the probes are removed. Pre-migration databases (tables not created yet) are still handled via an `isMissingTableError` catch. Saves two queries per render on pages that hydrate bylines and taxonomy terms.

On the fixture post-detail page: SQLite `/posts/[slug]` drops from 34 → 32, D1 from 43 → 39. The widget-area JOIN shaves one off every page that renders a widget area.

`invalidateBylineCache()` and `invalidateTermCache()` are preserved as no-op exports so callers don't break.
