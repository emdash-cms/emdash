---
"@emdash-cms/plugin-types": minor
"emdash": minor
"@emdash-cms/cloudflare": minor
"@emdash-cms/sandbox-workerd": minor
"@emdash-cms/plugin-cli": minor
"@emdash-cms/registry-lexicons": minor
"@emdash-cms/admin": minor
---

Adds the `bylines:read` plugin capability, which lets plugins read public byline profiles and the bylines credited on content entries through `ctx.bylines`.

`ctx.bylines` provides `get()` and cursor-paginated `list()` for profiles, plus `getEntriesBylines()` for credits. `getEntriesBylines()` resolves up to 100 entries of one collection in a single call, so a search indexer or feed plugin can attach author names to a page of `ctx.content.list()` results:

```ts
const page = await ctx.content.list("posts", { limit: 100 });
const credits = await ctx.bylines.getEntriesBylines(
	"posts",
	page.items.map((entry) => entry.id),
);
```

Credits match what the site renders: the credits assigned in the editor, or the author's linked byline, marked `source: "inferred"`, when an entry has none. They resolve at the entry's own locale. Profiles omit the linked user account, guest flag, and byline custom field values.

The capability is independent of `content:read` and `users:read`. It is available to native plugins and to sandboxed plugins on Cloudflare Worker Loader and Node.js workerd. Installation and update consent list it as a new permission.
