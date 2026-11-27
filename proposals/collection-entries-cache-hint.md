---
title: Cache hint for the entries a list shows
type: feature-plan
status: proposed
authors:
  - Kevin Kyburz (@swissky)
discussion: null
created: 2026-11-20
---

# Cache hint for the entries a list shows

## Problem and user case

`getEmDashCollection()` returns a `cacheHint` with the collection tag, for example `{ tags: ["posts"] }`. EmDash purges that tag whenever any entry in the collection is published, edited or deleted. That is right for an archive or home page, which must show a new post. It is costly for a page whose main content is something else and which only shows a short list next to it: a post page with "Continue reading", a Recent Posts widget in the sidebar or footer, or a related-posts block. Passing the list's hint there purges every such page whenever any post changes.

The blog and starter templates do this today. Each post page passes the `cacheHint` of its "Continue reading" list, so every post page carries the `posts` tag:

```astro
const { entries: recentPosts, cacheHint: recentPostsCacheHint } = await getEmDashCollection("posts", {
	orderBy: { published_at: "desc" },
	limit: 4,
});
if (Astro.cache?.enabled) Astro.cache.set(recentPostsCacheHint);
```

Editing one post therefore purges every post page on the site. Without `revisions`, each autosave of a published post does the same. On a CDN provider, each purge sends the following requests for those pages to the origin.

Tagging only the ids of the listed entries avoids this, but then a newly published post doesn't appear in those lists until the pages expire. Recent Posts widgets add a second problem: they render after the response headers are sent, so they can't add tags themselves. A page that wants to tag the widget's entries has to run the widget's query again in its frontmatter (`count` default 5, `orderBy: { published_at: "desc" }`, `locale: Astro.currentLocale`). Copied into every template, that query silently stops matching the widget when either changes: the widget then costs an extra query, and the tags describe a different list from the one rendered.

## Proposed behavior

### A tag for the set of live entries

EmDash adds a cache tag per collection, `emdash:entries:{collection}`, for example `emdash:entries:posts`. EmDash purges it when an entry enters or leaves the collection's live entries, or when the live order by publication date changes:

- an entry that wasn't live is published, by the publish route, by a save that publishes, or by a scheduled publication;
- a live entry is unpublished, moved to the trash or permanently deleted;
- a live entry is restored from the trash;
- the `publishedAt` of a live entry changes.

Saving a live entry otherwise purges only `[collection, id]`, as today. Publishing a pending revision of an entry that is already live is a save, not a new entry, so it doesn't purge the tag. That keeps collections with `revisions`, where every change reaches the site through a publish, from purging the tag on each edit.

Every write path that purges `[collection, id]` today applies the same rule: the content API routes, the MCP tools, plugin content writes and the scheduled-publishing sweep.

### `entriesCacheHint` on collection results

`CollectionResult` gains `entriesCacheHint: CacheHint`. Its tags are `emdash:entries:{collection}` and the ids of the entries in `entries`, the same id tag `getEmDashEntry()` returns for an entry and that EmDash purges when the entry is written. It never contains the collection tag.

```astro
const { entries: recentPosts, entriesCacheHint } = await getEmDashCollection("posts", {
	orderBy: { published_at: "desc" },
	limit: 4,
});
if (Astro.cache?.enabled) Astro.cache.set(entriesCacheHint);
```

A page that passes it is purged when a listed entry is written, when a new entry is published, and when an entry leaves the live set. It is not purged when an unlisted entry is edited.

`cacheHint` keeps its current value. A page chooses one of the two:

- `cacheHint` when the list depends on fields an edit can change: a filter on field values or taxonomy terms, or an order by title, `updated_at` or another editable field. An edit can move an unlisted entry into such a list.
- `entriesCacheHint` for lists of the latest or earliest entries, ordered by publication or creation date, with no filter beyond locale and status.

### Route rules must not add the collection tag

`Astro.cache.set()` merges a page's tags with the tags of its route rule. A route rule that names the collection keeps the page purged on every edit, whatever hint the page passes. The example rule in the route-caching guide tags `/blog/[slug]` with `posts`. The guide changes that rule to `tags: ["all"]` and says that a detail page using `entriesCacheHint` must not name its collection in the route rule. A content miss stays covered: `getEmDashEntry()` returns the collection tag for a miss, and the page passes it before rewriting to `/404`.

The sentence in the guide that recommends keeping the collection tag "for lists the page renders, such as related posts or widgets" points to `entriesCacheHint` instead.

### Widget areas can tag their Recent Posts entries

`getWidgetAreaWithCacheHint(name, { entries: true })` adds `emdash:entries:posts` and the entry ids of each Recent Posts widget in the area to the area's `cacheHint`. Core runs the same query as the widget, built by one shared function that `RecentPosts.astro` also uses. The widget then reuses the result from the request cache, and the query shape lives in one place. The locale comes from the request context, which holds `Astro.currentLocale`.

Without the option, the function behaves as today: it returns only the area tag and runs no content query. Sites that call it only for the tag, and render the list with their own code, see no change.

A page that renders a widget area tags it in its frontmatter:

```astro
const sidebar = await getWidgetAreaWithCacheHint("sidebar", { entries: true });
if (Astro.cache?.enabled) Astro.cache.set(sidebar.cacheHint);
```

`WidgetArea.astro` keeps its current call without the option. When the page has already called the function with `{ entries: true }`, the widget's query is a request-cache hit.

### Templates

The post pages in the blog and starter templates and in the demos and infra sites that copy them switch "Continue reading" to `entriesCacheHint` and tag their widget areas with `{ entries: true }`. Pages that render a widget area with Recent Posts without tagging it, such as the blog's `pages/[slug].astro` with its footer, add the call. None of these sites name a collection in a route rule today, so no rule changes.

## Goals

- Editing a post no longer purges post pages that don't list it.
- A newly published or removed post still purges every page whose secondary list could show it.
- A page can tag a widget area and the entries of its Recent Posts widgets with one call, without repeating the widget's query.
- Templates contain no copies of the Recent Posts query.
- Logged-out routes run no additional queries. The query-count snapshots for detail routes stay the same: the widget's query runs earlier, not twice.

## Non-goals

- Changing `cacheHint` on collection results, or the tags EmDash purges for edits.
- Membership tags per locale or per filter. `emdash:entries:{collection}` covers all locales of the collection, so publishing a German post also purges English pages that use the hint.
- Letting components set tags after the response headers are sent. That is a limit of Astro's streaming renderer.
- Hints for widget types other than Recent Posts. A page can call `getEmDashCollection()` for a plugin widget's list and use `entriesCacheHint`.

## Interfaces and compatibility

- `CollectionResult<T>` gains a required `entriesCacheHint: CacheHint` field. Code that reads collection results is unaffected. Code that builds a `CollectionResult` itself, such as a test fake, needs the new field.
- `getWidgetAreaWithCacheHint()` gains an optional second parameter. Existing calls keep their result and query count.
- Write paths purge `emdash:entries:{collection}` in addition to the tags they purge today, in the cases listed above. Pages that don't carry the tag are unaffected. On Cloudflare the extra tag goes into the same purge request, so purge rate limits are unchanged.
- Stored data, configuration and the object cache format are unchanged. `entriesCacheHint` is computed from the returned entries, so collection snapshots already in the object cache produce it without migration.
- Docs: the route-caching guide and the API reference describe `entriesCacheHint`, the membership tag and when it is purged, when to use each hint, the route rule change, and the widget area option. The `building-emdash-site` skill reference is updated to match. One `emdash` changeset (minor).

## Errors and edge cases

- **Error result:** `entriesCacheHint` is `{}`, like `cacheHint`.
- **Empty list:** `{ tags: ["emdash:entries:posts"] }`. The page is purged when the first entry is published.
- **Limit bucketing:** the request cache can load more entries than requested and slice them. `entriesCacheHint` holds only the entries the caller receives, so it is computed after slicing.
- **Preview and edit mode:** the hint holds the same tags. These requests aren't cached, so it has no effect there.
- **Republishing a live entry:** publishing a pending revision, or publishing again without a new `publishedAt`, keeps `published_at`. The write purges only `[collection, id]`.
- **Failed purge:** handled as today. The write succeeds and logs the failure, and pages stay cached until a later purge or their `maxAge`.
- **Large lists:** Cloudflare stores at most about 1,000 tags (16 KB) per response and drops invalid tags silently. A short list stays far below this, but `getEmDashCollection()` has no maximum `limit`, and a query without one returns every entry. The docs recommend `cacheHint` for long lists, since one collection tag fits any length.
- **Widget props:** the shared query function applies the widget's own defaults to a missing or invalid `count`, so the hint always describes the list the widget renders.
- **Failed widget query:** the area hint skips that widget's ids but keeps `emdash:entries:posts`, and the widget renders its own error state as it does today.

## Verification

- Core tests for `getEmDashCollection()`: `entriesCacheHint` holds the membership tag and the ids of the returned entries and no collection tag, after limit bucketing, on a request-cache hit, on an object-cache hit, and is `{}` on error. `cacheHint` is unchanged in all cases.
- Route and MCP tests for each write path: the membership tag is purged for a first publish, a scheduled publication, an unpublish, a trash, a restore, a permanent delete of a live entry and a `publishedAt` change. It is not purged for a save of a live entry, a publish of a pending revision, a republish without `publishedAt`, a trash or delete of a draft, or a save of a draft.
- Core tests for `getWidgetAreaWithCacheHint()`: without the option, the area tag only and no content query. With `{ entries: true }`, an area with Recent Posts widgets at different counts returns the area tag, the membership tag and exactly the ids each widget renders, across locales; an area without them returns only the area tag. Rendering the area afterwards runs no further content query.
- `pnpm query-counts`: no snapshot change on detail routes in the templates.
- Manual check with `memoryCache()` on the blog template: a post page and `pages/[slug]` carry the ids of the listed entries and `emdash:entries:posts` in their cache tags and no `posts` tag. Editing a listed post purges them, editing an unlisted post does not, and publishing a new post does.

## Open questions

- Is `entriesCacheHint` the right name, or should it be an option such as `getEmDashCollection(type, { cacheHint: "entries" })` that changes `cacheHint` itself? A separate field keeps both hints available from one cached query and avoids a second request-cache key.
- Should the membership tag be per locale (`emdash:entries:{collection}:{locale}`)? That would spare pages in other locales, but a query without a locale filter would need the tag of every locale.
