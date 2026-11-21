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

`getEmDashCollection()` returns a `cacheHint` with the collection tag, for example `{ tags: ["posts"] }`. EmDash purges that tag whenever any entry in the collection is published, edited or deleted. That is right for an archive or home page, which must show a new post. It is wrong for a page whose main content is something else and which only shows a short list next to it: a post page with "Continue reading", a Recent Posts widget in the sidebar or footer, or a related-posts block. Passing the list's hint there purges every such page whenever any post changes.

[#4994](https://github.com/emdash-cms/emdash/pull/4994) removed the collection tag from detail pages for this reason. To keep the lists on those pages fresh, the templates now tag the ids of the listed entries by hand:

```astro
const { entries } = await getEmDashCollection("posts", { orderBy: { published_at: "desc" }, limit: 4 });
if (Astro.cache?.enabled) Astro.cache.set({ tags: entries.map((p) => p.data.id) });
```

Recent Posts widgets render after the response headers are sent, so they can't add tags themselves. Each post page in the blog and starter templates therefore reads its widget areas, finds the Recent Posts widgets and runs their query again in the frontmatter, so the widget reuses the result from the request cache. The review of #4994 pointed out two problems with this:

- The block is copied into about 20 templates, demos and infra sites. It repeats the widget's query (`count` default 5, `orderBy: { published_at: "desc" }`, `locale: Astro.currentLocale`). If the widget's query changes, every copy silently stops sharing the request cache: each widget costs an extra query, and the tags describe a different list from the one rendered.
- Other pages that render the same widget areas, such as the blog's `pages/[slug].astro` with its footer, don't tag the widget's entries at all.

## Proposed behavior

### `entriesCacheHint` on collection results

`CollectionResult` gains `entriesCacheHint: CacheHint`. Its tags are the ids of the entries in `entries`, the same id tag `getEmDashEntry()` returns for an entry and that EmDash purges when the entry is written. It never contains the collection tag.

```astro
const { entries: recentPosts, entriesCacheHint } = await getEmDashCollection("posts", {
	orderBy: { published_at: "desc" },
	limit: 4,
});
if (Astro.cache?.enabled) Astro.cache.set(entriesCacheHint);
```

`cacheHint` keeps its current value. A page chooses one of the two:

- `cacheHint` when a newly published entry must appear at once, as on archives, home pages and feeds.
- `entriesCacheHint` when the list is secondary and a new entry can wait until the page expires. Editing, unpublishing or deleting a listed entry still purges the page.

### Widget areas tag their Recent Posts entries

`getWidgetAreaWithCacheHint(name)` adds the entry ids of each Recent Posts widget in the area to the area's `cacheHint`. Core runs the same query as the widget, built by one shared function that `RecentPosts.astro` also uses. The widget then reuses the result from the request cache, and the query shape lives in one place. The locale comes from the request context, which holds `Astro.currentLocale`.

A page that renders a widget area tags it in its frontmatter:

```astro
const footer = await getWidgetAreaWithCacheHint("footer");
if (Astro.cache?.enabled) Astro.cache.set(footer.cacheHint);
```

The blog and starter templates, demos and infra sites replace the copied block with these calls. Pages that render a widget area without tagging it today, such as the blog's `pages/[slug].astro`, add them.

`WidgetArea.astro` already calls `getWidgetAreaWithCacheHint()`. Its call now waits for the Recent Posts queries before rendering, and the widgets reuse those results.

## Goals

- A page can tag the entries of a list it shows with one call, without the collection tag.
- A page can tag a widget area and the entries of its Recent Posts widgets with one call, without repeating the widget's query.
- Templates no longer contain copies of the Recent Posts query.
- Logged-out routes run no additional queries. The query-count snapshots for detail routes stay the same: the widget's query runs earlier, not twice.

## Non-goals

- Changing `cacheHint` on collection results, or the tags EmDash purges on writes.
- Showing new entries on pages that use `entriesCacheHint` before the page expires. That needs a tag that is purged on publish but not on edits, which the current tag model doesn't have.
- Letting components set tags after the response headers are sent. That is a limit of Astro's streaming renderer.
- Hints for widget types other than Recent Posts. A page can call `getEmDashCollection()` for a plugin widget's list and use `entriesCacheHint`.

## Interfaces and compatibility

- `CollectionResult<T>` gains a required `entriesCacheHint: CacheHint` field. Code that reads collection results is unaffected. Code that builds a `CollectionResult` itself, such as a test fake, needs the new field.
- `getWidgetAreaWithCacheHint()` keeps its signature. Its hint gains entry ids when the area contains Recent Posts widgets, so a page that already passes it is now purged when a listed post changes. Before, such a page kept showing an edited or unpublished post in the widget until it expired.
- A page that calls `getWidgetAreaWithCacheHint()` without rendering the area now runs the Recent Posts query. The templates don't do this.
- Stored data, configuration and the object cache format are unchanged. `entriesCacheHint` is computed from the returned entries, so collection snapshots already in the object cache produce it without migration.
- Docs: the route-caching guide and the API reference describe `entriesCacheHint`, when to use each hint, and the widget area hint. The `building-emdash-site` skill reference is updated to match. One `emdash` changeset (minor).

## Errors and edge cases

- **Error result:** `entriesCacheHint` is `{}`, like `cacheHint`.
- **Empty list:** `{ tags: [] }`. A page that lists no entries is not purged when the first entry is published, which is the documented `entriesCacheHint` trade-off.
- **Limit bucketing:** the request cache can load more entries than requested and slice them. `entriesCacheHint` holds only the entries the caller receives, so it is computed after slicing.
- **Preview and edit mode:** the hint holds the same entry ids. These requests aren't cached, so it has no effect there.
- **Large lists:** Cloudflare stores at most about 1,000 tags (16 KB) per response and drops invalid tags silently. A short list stays far below this, but `getEmDashCollection()` has no maximum `limit`, and a query without one returns every entry. The docs recommend `cacheHint` for long lists, since one collection tag fits any length.
- **Widget props:** the shared query function applies the widget's own defaults to a missing or invalid `count`, so the hint always describes the list the widget renders.
- **Failed widget query:** the area hint skips that widget's ids, and the widget renders its own error state as it does today.

## Verification

- Core tests for `getEmDashCollection()`: `entriesCacheHint` holds the ids of the returned entries and no collection tag, after limit bucketing, on a request-cache hit, on an object-cache hit, and is `{}` on error. `cacheHint` is unchanged in all cases.
- Core tests for `getWidgetAreaWithCacheHint()`: an area with Recent Posts widgets at different counts returns the area tag and exactly the ids each widget renders, across locales; an area without them returns only the area tag. Rendering the area after calling it runs no further content query.
- `pnpm query-counts`: no snapshot change on detail routes in the templates; a route that starts tagging a widget area shows no added query when the area is rendered.
- Manual check with `memoryCache()` on the blog template: a post page and `pages/[slug]` carry the ids of the footer and sidebar Recent Posts entries in `Cache-Tag` and no `posts` tag; editing a listed post purges them, publishing an unrelated post does not.

## Open questions

- Is `entriesCacheHint` the right name, or should it be an option such as `getEmDashCollection(type, { cacheHint: "entries" })` that changes `cacheHint` itself? A separate field keeps both hints available from one cached query and avoids a second request-cache key.
- Should the widget area change ship with this plan, or as a follow-up plan once `entriesCacheHint` exists?
