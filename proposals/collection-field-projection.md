---
title: Select only named fields in a collection read
type: rfc
status: proposed
authors:
  - Noah Eisenbruch (@eisenbruch)
champion: Noah Eisenbruch (@eisenbruch)
sponsor: null
discussions:
  - https://github.com/emdash-cms/emdash/discussions/3086
created: 2026-11-13
---

# Select only named fields in a collection read

## Summary

`getEmDashCollection` accepts an optional `fields` list naming the content fields the caller will read. The list query then selects those fields' columns plus the system columns, instead of every column, and `entry.data` holds only the named fields. With generated collection types, the result type narrows to the named fields, and a name that is not a field of the collection is a type error or, at run time, an error thrown before the query runs. Without `fields`, nothing changes.

This RFC replaces the feature plan merged in #4724 and reverted in #4815, which should have been an RFC because it changes a public API and the list read that logged-out pages use. The design is the one that plan described, with the corrections from the #3204 review. #3204 is the implementation and stays on hold until this RFC is accepted. The RFC covers the field-selection half of Discussion #3086, not relationship loading.

## Problem and user case

`getEmDashCollection` reads every column of every entry it returns. A card, a teaser, a related-posts rail or an archive row needs a title, an excerpt and an image, but the list query also returns each entry's whole `body`. On a content site the body is most of the database.

Measured on a production site (D1, Cloudflare Workers): 1,891 published articles with an average `body` of 8.79 KB, 16.6 MB in all. A cold home page read about 93 article rows to draw 26 cards, so about 800 KB left the database to render about 40 KB of markup. A list's `limit` becomes a payload rather than a count: raising one list from 15 to 25 entries to fill eight cards moved about 90 KB more, none of it displayed.

There is no workaround inside EmDash. A site can only avoid the cost by querying the database itself, which skips the loader's locale handling, draft preview, hydration and caching.

## Example

```ts
const { entries } = await getEmDashCollection("articles", {
	status: "published",
	limit: 12,
	orderBy: { published_at: "desc" },
	fields: ["title", "excerpt", "hero_image"],
});

entries[0].data.title; // string
entries[0].data.slug; // always present
entries[0].data.body; // type error: not requested
```

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

## Detailed design

### Public API

`CollectionFilter` gains `fields?: readonly string[]` on both the cursor and offset variants. `getEmDashCollection` gains a third, `const` type parameter for the named fields, inferred from the call, so the result type can narrow. `getEmDashEntry` already narrows its result to the `references` a caller names in the same way.

### Selection

- **System columns are always selected:** the id, slug, status, locale, translation group, timestamps and revision ids, plus the columns the query sorts by. A sort column is needed because the next cursor is read from the last row; a page sorted by an unselected column would return the same page forever.
- **Filters and sorting may use fields that are not selected.** `where` and `orderBy` name columns in the query, not in the result.
- **Hydration is unchanged.** Taxonomy terms, bylines and boolean fields are loaded by their own subqueries and are returned as before. Collection reads do not return SEO; only the single-entry read does.
- **Draft preview has the same shape as the live read.** When a draft revision overlays an entry, only the requested fields are taken from the revision. In edit mode, the empty-array fill for Portable Text fields covers only requested Portable Text fields.
- The option applies to every list path inside `getEmDashCollection`: the plain query and both branches of the taxonomy-pivot query.

### Accepted names

- The collection's field slugs.
- The system fields the generated types use (`id`, `slug`, `status`, `createdAt`, `updatedAt`, `publishedAt`, `byline`, `bylines`, `terms`). They select nothing extra, since every entry carries them.
- Duplicates are ignored.

### Types

The narrowed `data` is a `Pick` of the collection's generated interface plus the keys the loader fills on every entry. A collection without generated types keeps `Record<string, unknown>`. A caller that passes the type arguments explicitly, as `getEmDashCollection<"posts", Post>(...)`, gets the full type, as today. On a typed collection, a literal list must name the collection's fields. A list typed only as `string[]`, such as a variable or a `CollectionFilter` passed through, cannot be checked: it is accepted and keeps the full type. There is one signature, with the check as a conditional type on the field parameter, so a literal typo cannot fall through to a looser overload. Checked with `tsc` and `tsgo`.

### Validation and errors

A projected read that returns an empty list, or entries silently missing a field, looks to a template like missing content. Every rule below follows from that.

- **An unknown name throws before the query runs.** The check cannot be left to the database: the loader catches a failed list query and returns it as `error` with no entries, so a template that reads only `entries` would render a mistyped name as "no entries". Raw column names such as `created_at` and internal aliases such as `_emdash_terms` are unknown names.
- **A malformed name throws.** Names are interpolated as identifiers, so they are checked against the field-name pattern first.
- **An empty array throws.** It most likely means a caller computed the list and got nothing.
- **A reference field bound to a relation throws**, with the message the loader already gives when one is named in `where` or `orderBy`, pointing to `getEmDashEntry(..., { references })` and `getEmDashReferences()`. Such a field has no column, or a stale one. The check is the one `where` and `orderBy` use (`findStoragelessQueryKey`).
- **A reference field not bound to a relation is selected like any other field**, returning the stored entry id the generated types already describe.

The field and reference-binding lookups read one cached field index per collection (per request and in the schema namespace of the object cache), shared with the reference-field map, so a render that projects fields and also filters on references pays one schema read.

## Compatibility and migration

The change is additive. Calls without `fields` select, return, type and cache exactly as today; their cache keys are unchanged. No stored data, migration, configuration or plugin surface changes.

The narrowed type is the part that is hard to change later: once sites rely on `Pick`-shaped data, widening it is not a breaking change but narrowing it further would be. Calls with explicit type arguments and calls with a `string[]` list keep the full type, so no existing call changes type.

Rollback for a site is removing `fields` from its calls. Rollback for the project before a release is reverting the implementation; after a release, the option would have to go through the deprecation process.

## Security and privacy

- **Untrusted input:** names are interpolated as SQL identifiers. Each is checked against the collection's schema and the field-name pattern before any SQL is built, so a name from user input cannot reach the query unchecked. Values are not involved.
- **Authorization:** unchanged. The option can only narrow what a read returns. The draft overlay still applies only where preview is already authorized.
- **Secrets and privacy:** no new storage, logging or transport.

## Performance

This is on the read path of logged-out pages, which is why it is an RFC.

- **Without `fields`:** no change to the query or its cost. The cache key computation gains one branch.
- **With `fields`:** the same rows are read, with fewer columns. D1 bills rows read, so the row count is unchanged; the bytes moved from the database to the Worker, and the memory and JSON work spent on them, fall roughly by the share of the row the omitted fields hold. On the site measured above, that is the body, most of each row.
- **Schema check:** one cached field-index read per collection per request, shared with the existing reference-field map; no extra statement when that map is already read.
- **Cache:** a projected read and a full read of the same list are cached under separate keys, so a site mixing both stores both.

Measurement plan: before acceptance of the implementation, the same list read with and without `fields` on a collection with a long `body`, on D1, comparing the result size, rows read and statements per request, and reported on #3204.

## Failure handling

Every error in this design is thrown before the query runs, with a message naming the field and the collection, so a mistake fails the render visibly instead of returning empty or partial data. A database failure during a projected read is handled as for any list read today. There is no retry or operator action specific to this option.

## Verification

Loader tests on SQLite and PostgreSQL:

- Requested fields are present on `entry.data` and unrequested ones are absent.
- Without `fields`, every field is present.
- System metadata on a projected entry equals that of the same entry read without `fields`.
- Cursor pagination across several pages, sorted by a field that is not requested.
- A projected read through the taxonomy-pivot path.
- Taxonomy terms, bylines and boolean fields are hydrated on a projected entry.
- With a draft revision overlay, only requested fields come from the revision; in edit mode only requested Portable Text fields are filled.
- An unknown field, a raw column name, a malformed name, an empty array and a bound reference field each throw, and none returns an empty list.
- An unbound reference field is selected and returns its stored entry id.
- A projected read and a full read of the same list in one request each return their own shape.

Type tests: a projected read exposes the named fields and the always-filled keys; reading an unrequested field and naming a field the collection does not have are type errors; a variable list, a spread `CollectionFilter` and a `string[]` list are accepted with the full type; a collection without generated types and a call with explicit type arguments keep their current types.

Manual: on a site with a long `body`, the same list read with and without `fields`, comparing the result size and the rendered output.

## Rollout and implementation

One pull request, #3204, rebased and updated to this RFC once accepted, with a minor changeset and the API reference updated. No feature flag: the option does nothing until a caller passes it.

## Alternatives

- **An exclusion list (`omit: ["body"]`).** Simpler to adopt, but it cannot narrow the type usefully, and a field added to the collection later is read by every list until someone adds it to the exclusion.
- **Never selecting large fields in list reads by default.** A breaking change for every template that renders a body from a list.
- **A separate card or summary API.** A second read path with its own caching, locale and preview handling, duplicating the loader.
- **Leaving it to sites.** Raw queries skip locale fallback, draft preview, hydration and caching; this is what sites do today when the cost matters.

## Drawbacks

- **A projected entry is a partial entry.** Anything a site derives from an unselected field sees nothing rather than falling back. On the site measured above, cards fell back to an excerpt computed from `body` when the stored excerpt was empty; projecting before backfilling stored excerpts would have blanked 62% of them. The documentation states this, and the narrowed type catches direct reads, but not reads through untyped helpers.
- **Type complexity.** A third type parameter and a conditional type on `getEmDashCollection`.
- **Cache fan-out.** Each distinct field list for the same query is a separate cache entry.

## Open questions

None that affect the public contract. Extending the option to the REST list, the MCP `content_list` tool and the plugin `list` methods is left to separate proposals.
