---
"emdash": minor
---

Adds a `fields` option to `getEmDashCollection`, which reads only the named content fields instead of every column. Use it for lists that render cards or archive rows, so each entry's body is not read:

```ts
const { entries } = await getEmDashCollection("posts", {
	fields: ["title", "excerpt", "featured_image"],
});
```

System fields, sort columns, taxonomy terms and bylines are still returned, and `where` and `orderBy` can use fields that are not requested. A projected entry is partial: an unrequested field is absent from `entry.data`, and with generated collection types `entry.data` is narrowed to the requested fields. An empty list, a malformed or unknown field name, or a `reference` field bound to a relation throws before any query runs. Without `fields`, nothing changes.
