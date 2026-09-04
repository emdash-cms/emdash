---
"emdash": minor
---

**Breaking (MCP clients):** Requires `_rev` on the MCP `content_update`, `content_publish`, `content_unpublish` and `content_discard_draft` tools, so an agent can no longer write over changes it never read. The CLI has always required the token on `content update`; the MCP surface now matches it.

The four tools previously accepted `_rev` as an optional parameter and performed the write when it was omitted. Such a call now fails validation with a message naming `content_get`. To migrate, read the item first and pass back the token from the response:

```json
{
	"collection": "posts",
	"id": "01K4EXAMPLEID0000000000",
	"data": { "title": "New title" },
	"_rev": "MzoyMDI2LTA5LTA0IDEyOjMwOjAw"
}
```

The token is opaque; pass it through unchanged. A write built on a stale token fails with `CONFLICT`, so read the item again and retry with the new token. There is no option to restore the previous behavior. The tool descriptions state the same protocol, so an agent reading the schema follows it without being told.
