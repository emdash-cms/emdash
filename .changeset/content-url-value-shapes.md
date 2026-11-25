---
"emdash": patch
---

Applies link scheme checks to more of the places content stores a URL.

- The `src`, `url`, and `previewUrl` of `image` and `file` values, including a `darkVariant` and image sub-fields of repeaters, now accept only `http:` and `https:` URLs and paths without a scheme. The content API, MCP tools, seeds, and plugin content writes reject other schemes, such as `javascript:`, `data:`, and `blob:`, with a validation error. Seeds and plugin content writes check these values outside `blocks` fields, and also reject a URL that is not text.
- Seeds, plugin content updates, and site imports reject a `url` field value that is not text, or text that starts with `[` or `{`. Queries return stored text that looks like JSON as an array or object, so such a value did not read back as the text that was checked.
- Site import analysis reports a `dangling_reference` blocker for a block in an entry or revision whose block type or version is not in the package. Previously the URL fields of such a block were not checked.
- `getEmDashEntry()` and `getEmDashCollection()` drop a `__proto__` key in stored content instead of turning it into the prototype of the returned object, so a repeater row no longer exposes values that were stored under that key as its own fields. Search indexing ignores the key as well.

Existing entries are not changed. A stored value that the new checks reject is still returned by queries, but saving or duplicating that entry fails until the field is corrected. To render older values safely, pass the URL through `sanitizeHref()` before putting it in an `href`.
