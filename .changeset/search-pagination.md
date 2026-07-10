---
"emdash": minor
---

Implements pagination for `search()` and `searchCollection()`

`search()` advertised keyset pagination through its types (`options.cursor`, `SearchResponse.nextCursor`) but never read the cursor or returned one, so results were silently capped at `limit` with no way to load a second page.

Both `search()` and `searchCollection()` now honour `cursor` and return a `nextCursor` whenever more matches exist. Pass the previous `nextCursor` back as `cursor` to walk subsequent pages; it becomes `undefined` on the last page. The `/_emdash/api/search` endpoint accepts a `cursor` query parameter and returns `nextCursor` in its response (a malformed cursor returns a 400 `INVALID_CURSOR`).

```ts
let cursor: string | undefined;
do {
	const { items, nextCursor } = await search("quarterly report", { limit: 20, cursor });
	render(items);
	cursor = nextCursor;
} while (cursor);
```
