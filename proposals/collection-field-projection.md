---
title: Select only named fields in a collection read
type: feature-plan
status: proposed
authors:
  - Noah Eisenbruch (@eisenbruch)
discussion: https://github.com/emdash-cms/emdash/discussions/3086
created: 2026-11-07
---

# Select only named fields in a collection read

This plan records the design behind #3204, opened on September 18, 2026 before this process existed, and settles the points that PR leaves open. #3204 is a working prototype of the option and has run on our production site since September. Once this plan is accepted, #3204 will be updated to match it, including the field validation, the draft overlay and the result type below. It covers the field-selection half of Discussion #3086, not relationship loading.

## Problem and user case

`getEmDashCollection` reads every column of every entry it returns. A card, a teaser, a related-posts rail or an archive row needs a title, an excerpt and an image, but the list query also returns each entry's whole `body`. On a content site the body is most of the database.

Measured on our production site (D1, Cloudflare Workers): 1,891 published articles with an average `body` of 8.79 KB, 16.6 MB in all. A cold home page read about 93 article rows to draw 26 cards, so about 800 KB left the database to render about 40 KB of markup. A list's `limit` becomes a payload rather than a count: raising one list from 15 to 25 entries to fill eight cards moved about 90 KB more, none of it displayed.

There is no workaround inside EmDash. A site can only avoid the cost by querying the database itself, which skips the loader's locale handling, draft preview, hydration and caching.

## Proposed behavior

`getEmDashCollection` accepts a new optional `fields` option: the content fields the caller will read.

```ts
const { entries } = await getEmDashCollection("articles", {
	status: "published",
	limit: 12,
	orderBy: { published_at: "desc" },
	fields: ["title", "excerpt", "hero_image"],
});
```

The list query then selects those fields' columns instead of every column. Each entry's `data` holds the requested fields and nothing else from the collection's own fields.

- **Without `fields`, nothing changes.** Every column is selected, as today.
- **System columns are always selected:** the id, slug, status, locale, translation group, timestamps and revision ids, plus the columns the query sorts by. Pagination, cursors, locale resolution and the metadata on `entry.data` behave the same with or without `fields`. A sort column is needed because the next cursor is read from the last row; a page sorted by an unselected column would return the same page forever.
- **Hydration is unchanged.** Taxonomy terms, bylines, SEO and boolean fields are loaded by their own subqueries, not by `SELECT *`, and are returned as before.
- **Draft preview has the same shape as the live read.** When a draft revision overlays an entry, only the requested fields are taken from the revision, so a template sees the same keys in preview as on the live site.
- **Filters and sorting may use fields that are not selected.** `where` and `orderBy` name columns in the query, not in the result.
- **The result type narrows.** With generated collection types, `entry.data` for a projected read is typed as the named fields plus the keys the loader fills on every entry (`id`, `slug`, `status`, the dates, bylines and terms), so a template that reads an unrequested field fails to type-check instead of rendering nothing. A name that is not a field of the collection is a type error too.

## Goals

- Let a list read only the content fields its template uses.
- Keep pagination, cursors, locale fallback, draft preview and hydration identical with and without `fields`.
- Never let a mistaken field name produce a plausible empty or partial result.
- Change nothing for callers that do not pass `fields`.

## Non-goals

- Relationship loading, the other half of Discussion #3086.
- `getEmDashEntry`. A single entry page normally renders its body.
- Entries loaded to resolve `reference` fields (`loadEntriesByGroups`).
- The REST content list, the MCP `content_list` tool, and the client and plugin `list` methods.
- Serving a projected read from a cached full read of the same list. Each is cached under its own key.
- Changing any stored data, the default selection, or what a full read returns.

## Interfaces and compatibility

- **Public API:** `CollectionFilter` gains an optional `fields?: readonly string[]` on both the cursor and offset variants. `getEmDashCollection` gains a third, `const` type parameter for the named fields, constrained to the collection's field names and inferred from the call, so the result type can narrow. `getEmDashEntry` already narrows its result to the `references` a caller names in the same way.
- **Types, in detail:** the narrowed `data` is a `Pick` of the collection's generated interface. A collection without generated types keeps `Record<string, unknown>`. A caller that passes the type arguments explicitly, as `getEmDashCollection<"posts", Post>(...)`, gets the full type, as today. On a typed collection, a list widened to `string[]` is rejected; it has to be written inline or typed as the collection's field names. This was checked with `tsc` and `tsgo` against a model of the generated types.
- **Cache:** the request cache and the object cache key on the sorted field list, so a projected read and a full read never share an entry, and the order of the names does not split one request into two keys. Keys for reads without `fields` are unchanged.
- **Stored data, migrations, configuration and plugin surface:** none.

The option applies to every list path inside `getEmDashCollection`: the plain query and both branches of the taxonomy-pivot query.

## Errors and edge cases

A projected read that returns an empty list, or entries silently missing a field, looks to a template like missing content. Every rule below follows from that.

- **A name that is not a field of the collection is an error, thrown before the query runs.** The check cannot be left to the database: the loader catches a failed list query and returns it as `error` on the result with no entries, so a template that reads only `entries` would render a mistyped name as "no entries". The check reads the collection's fields through the same per-request, object-cached schema lookup the loader already uses for filter keys.
- **A malformed name is an error.** It is interpolated as an identifier, so it is checked against the field-name pattern first.
- **An empty array is an error.** It most likely means a caller computed the list and got nothing, and selecting only system columns is not a useful read.
- **A reference field bound to a relation is an error**, with the message the loader already gives when one is named in `where` or `orderBy`, pointing to `getEmDashEntry(..., { references })` and `getEmDashReferences()`. Such a field has no column, and list reads never fill it. A field bound after its column existed still has the column, holding values it no longer writes, so selecting it would return stale data. The check is the one `where` and `orderBy` use (`findStoragelessQueryKey`), on the same cached reference-field lookup.
- **A reference field that is not bound to a relation is selected like any other field.** Fields created before relations keep their own column, holding an entry id, and the generated types already type them that way.
- **System field names are accepted** and change nothing, since those columns are always selected. Duplicates are ignored.
- **A projected entry is a partial entry.** Anything a site derives from an unselected field sees nothing rather than falling back. On our site, cards fell back to an excerpt computed from `body` when the stored excerpt was empty; projecting without first backfilling stored excerpts would have blanked 62% of them. The option's documentation states this, and the narrowed type catches direct reads.

## Verification

Loader tests on SQLite and PostgreSQL:

- Requested fields are present on `entry.data` and unrequested ones are absent.
- Without `fields`, every field is present.
- System metadata on a projected entry equals that of the same entry read without `fields`.
- Cursor pagination across several pages, sorted by a field that is not requested.
- A projected read through the taxonomy-pivot path.
- Taxonomy terms, bylines, SEO and boolean fields are hydrated on a projected entry.
- With a draft revision overlay, only requested fields come from the revision.
- An unknown field, a malformed name, an empty array and a bound reference field each throw, and none returns an empty list.
- An unbound reference field is selected and returns its stored entry id.
- A projected read and a full read of the same list in one request each return their own shape.

Type tests: `entry.data` of a projected read exposes the named fields and the always-filled keys; reading an unrequested field, and naming a field the collection does not have, are type errors; a collection without generated types and a call with explicit type arguments keep their current types.

Manual verification on a site with a long `body`: the same list read with and without `fields`, comparing the rows' size and the rendered output.
