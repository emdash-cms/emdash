---
"emdash": minor
---

Adds offset pagination to `getEmDashCollection` for numbered archive routes

`getEmDashCollection` now accepts an `offset` option alongside `limit`, so you can render numbered archive URLs like `/page/2` or `/tag/security/page/3` without walking cursors or over-fetching from the start:

```ts
const perPage = 20;
const { entries, hasMore } = await getEmDashCollection("posts", {
	limit: perPage,
	offset: (page - 1) * perPage,
	orderBy: { published_at: "desc" },
});
```

Results now include a `hasMore` boolean whenever `limit` is set, so you can show a "next page" link without an extra count query. `offset` is ignored when a `cursor` is supplied — cursor (keyset) pagination still wins.
