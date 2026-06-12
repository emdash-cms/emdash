---
"emdash": minor
---

Add content filtering by byline credit. `getEmDashCollection` now accepts a reserved `byline` key in `where` that returns entries credited to a byline in any position, including co-authored entries where the byline is a secondary credit. This makes author archive pages possible without querying the database directly. Pass a single byline translation group or an array to match any of several.

```ts
const byline = await getBylineBySlug("jane-doe");
const { entries } = await getEmDashCollection("posts", {
  where: { byline: byline.translationGroup ?? byline.id },
  orderBy: { published_at: "desc" },
});
```

A `getEntriesByByline(collection, byline, options)` helper wraps the same filter, mirroring `getEntriesByTerm`.
