---
"@emdash-cms/cloudflare": minor
---

New experimental `coalesce` option for the `d1()` adapter, for much faster uncached page loads:

```ts
emdash({
	database: d1({ binding: "DB", session: "auto", coalesce: true }),
});
```

When enabled, read queries that a page issues at the same time are sent to D1 as a single round trip instead of one at a time. A page that runs half a dozen queries — settings, menus, the entry, related posts — pays for one trip to the database instead of six, which can cut uncached render time by more than half. Each query still gets its own results and its own errors, and writes are unaffected. Requires `session` to be enabled; off by default while experimental.
