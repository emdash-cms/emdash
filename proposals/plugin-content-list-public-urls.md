---
title: Public URLs in a plugin's content list
type: rfc
status: proposed
authors:
  - Daniel Mueller (@danielmlr)
champion: Daniel Mueller (@danielmlr)
sponsor: null
discussions:
  - https://github.com/emdash-cms/emdash/discussions/3366
created: 2026-10-15
---

# Public URLs in a plugin's content list

## Summary

A plugin can ask `ctx.content.list()` to return each entry's public URL with the entry, by passing `publicUrl: true`. Each item then carries `publicUrl`, the same value `ctx.content.getPublicUrl()` returns for that entry: the URL the site serves, or `null` when the entry has none. A page of up to 100 entries with their URLs costs one plugin call instead of one call plus one per entry.

Nothing changes for a plugin that does not pass the option. This RFC covers only this option. Fetching entries by ID, translation lookups for many entries, and reference checks stay with [#4153](https://github.com/emdash-cms/emdash/discussions/4153).

## Problem and user case

A plugin that works with the site's pages needs their public URLs, and only core knows them. `getPublicUrl()` applies the collection's URL pattern, the locale prefix and the trailing-slash setting, so its result matches what the site serves. A plugin that builds URLs itself drifts from that.

`getPublicUrl()` takes one entry. In the Cloudflare sandbox every `ctx` call to the host counts toward the invocation's limit of 10 subrequests, so a plugin that needs URLs for a page of entries pays one call for the page and one for each entry:

- A web analytics plugin matches the paths its provider reports to entries. Its walk over existing content takes seven calls per run for everything else, so it gets three URLs per run. With a run every half hour, a site with 1,000 published entries waits about a week before every entry has its numbers ([#3366](https://github.com/emdash-cms/emdash/discussions/3366)).
- An events plugin that lists 20 published events with their links needs 21 calls before it reads settings or references ([#4004](https://github.com/emdash-cms/emdash/issues/4004)).

Raising the limit ([#3383](https://github.com/emdash-cms/emdash/pull/3383)) moves the ceiling but keeps one call per entry.

Everything `getPublicUrl()` reads from an entry is already in a `list()` item: ID, slug, status, locale and publish date. The rest is the collection's URL pattern and the site's settings, which are the same for the whole page.

## Example

```ts
const page = await ctx.content.list("posts", {
	where: { status: "published" },
	limit: 100,
	publicUrl: true,
});

for (const item of page.items) {
	// "https://example.com/de/blog/hallo-welt/" or null
	console.log(item.id, item.publicUrl);
}
```

Without `publicUrl: true`, items have no `publicUrl` key, as today.

## Goals

- One `list()` call returns a page of entries with their public URLs, in every plugin runner.
- Each `publicUrl` equals what `getPublicUrl()` returns for the same entry at the same moment, including `null`.
- The option adds no query on the host, whatever the page size.
- A plugin can tell an older host, which ignores the option, from an entry without a URL.

## Non-goals

- Public URLs for entries a plugin holds by ID, without listing them. That needs limits and rules for missing IDs, and belongs with the bulk fetch by ID in #4153.
- Translation lookups for many entries, and reference checks before a delete (#4153).
- A higher subrequest limit (#3383).
- Preview URLs. `getPublicUrl()` never returns one, and neither does this option.
- Public URLs in `get()`, the REST API or MCP.

## Detailed design

### Interface

`ContentListOptions` gains an optional `publicUrl?: boolean`, and the plugin `ContentItem` type gains an optional `publicUrl?: string | null`:

- `publicUrl: true`: every item in `items` has a `publicUrl` key, a string or `null`.
- `publicUrl` left out or any value other than `true`: no item has the key.

The option needs `content:read`, the capability `list()` and `getPublicUrl()` already require. It combines with `where`, `orderBy`, `limit` and `cursor` and changes none of them: the same page comes back, with the URLs added.

### Resolution

The host resolves the URLs after it reads the page:

1. It reads the collection's `routable` and `urlPattern` once for the page, in the query `list()` already runs on a non-empty page to check whether the collection has SEO.
2. For each item it applies the rules `getPublicUrl()` applies today. The result is `null` when the site has no URL configured, the entry is not published, it has no slug, the collection is not routable, or the site does not serve the entry's locale. Otherwise it is the site URL followed by the localized path, with the site's trailing-slash setting.

Step 2 runs in memory. The path resolver reads routing config, not the database, as the sitemap does when it resolves a page of entries.

`getPublicUrl()` and the list option share one function for step 2, so the two cannot disagree.

### Runners

- **In-process plugins:** the plugin content access in core.
- **Cloudflare sandbox:** the bridge already passes `list()` options to the same core function, so the option works there once core supports it.
- **workerd sandbox:** the bridge handler builds a new options object from the request, field by field. It must pass `publicUrl` through as a boolean. When `list()` fails on a call without `where` or `orderBy`, the handler falls back to reading the table directly. That page has no URLs, so with `publicUrl` set the call must fail instead, as it already does with `where` or `orderBy`.

## Compatibility and migration

The change is additive: one optional option and one optional field on an item. No stored data, migration, capability or default changes. A plugin that does not pass the option gets the same response as today.

A plugin that passes the option to an older host gets items without a `publicUrl` key. The in-process host and the Cloudflare bridge ignore an unknown option, and the workerd bridge drops it. Because the new host always sets the key when asked, an item where `publicUrl` is `undefined` means an older host, and the plugin can fall back to `getPublicUrl()` for that page.

## Security and privacy

No new data becomes readable. A plugin with `content:read` can already read every listed entry and call `getPublicUrl()` on it. The option returns the same values without extra calls. It returns only URLs of published entries in routable collections, never a preview or draft URL. The collection name passes the same validation as today's `list()`.

## Performance

- Without the option, no change: no extra query on any route, logged-out pages included.
- With the option, the host runs the same queries as without it. The collection row it needs is the one `list()` already reads for the SEO check, and the URLs cost no query per entry.
- A plugin replaces 1 + N calls with one call for a page of N entries, up to the page maximum of 100. The analytics plugin in #3366 would need seven calls for a 100-entry page instead of 107.

## Failure handling

If reading the page or the collection's row fails, the whole `list()` call fails in every runner. The host never returns a page with some URLs missing, which would look like entries without URLs. An entry whose URL cannot be built gets `null`, by the same rules as `getPublicUrl()`.

## Verification

- For a mixed page, each item's `publicUrl` equals `getPublicUrl()` for the same entry. The page includes a published entry, a draft, an entry without a slug, a locale the site does not serve, a prefixed locale, and the trailing-slash settings `always` and `never`.
- An unroutable collection returns `null` for every item. A host without a site URL returns `null` for every item.
- Without the option, no item has a `publicUrl` key.
- The option combines with `where`, `orderBy` and `cursor` and returns the same page as without it.
- The option runs the same number of queries as the same `list()` call without it, on pages of 1 and 100 entries, for collections with and without SEO.
- The Cloudflare and workerd bridges return the URLs to a sandboxed plugin, and a non-boolean value is not passed on as `true`. When core cannot read the page, a workerd call with the option fails instead of returning a page without URLs.

## Rollout and implementation

One implementation pull request, with a changeset for each published package it changes:

1. Move step 2 of the resolution out of `getPublicUrl()` into a shared function, and use it from `list()` when the option is set.
2. Pass the option through the workerd bridge handler, and skip its direct table read when the option is set.
3. Document the option in the plugin capabilities reference and the plugin authoring skill.

No feature flag. The option is off unless a plugin passes it.

## Alternatives

- **`getPublicUrls(collection, ids)`.** This serves plugins that hold IDs from their own storage. It needs a cap on the number of IDs and a rule for IDs that no longer exist, which are the questions #4153 raises for fetching entries by ID. Settling them once there is better than settling them twice.
- **A higher subrequest limit (#3383).** This keeps one call per entry, so it postpones the problem instead of removing it.
- **URLs built by the plugin from the schema.** This drifts from the site: the issue in #4004 found differences for fallback paths, repeated slug tokens, ID and date tokens, unroutable collections and trailing-slash settings.

## Drawbacks

- `ContentItem` gains a field that exists only when the option is passed, so its type alone does not say whether a given item has it.
- A plugin that holds IDs rather than listing a collection still pays one call per entry until #4153 adds a fetch by ID.

## Open questions

1. **Option shape.** `publicUrl: true` is the smallest option. A list of extras, such as `include: ["publicUrl"]`, would leave room for more per-page data that #4153 might want. Which shape should `list()` take?
2. **Typing.** Should `list()` get an overload so that items have `publicUrl: string | null` when the option is the literal `true`, or is the optional field enough?
