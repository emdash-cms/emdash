---
title: Reference fields in collection listings
type: rfc
status: proposed
authors:
  - Itai Ben Zeev (@itaides)
champion: Itai Ben Zeev (@itaides)
sponsor: null
discussions:
  - https://github.com/emdash-cms/emdash/discussions/3598
  - https://github.com/emdash-cms/emdash/discussions/410
created: 2026-10-11
---

# Reference fields in collection listings

## Summary

`getEmDashCollection` accepts the same `references` selection that `getEmDashEntry` accepts. Each returned entry then carries `entry.references.<field>` with the same pages, order, cursors, locale and draft behaviour the single-entry path produces. Links are read in batches across the page, not once per entry. Calls that don't pass `references` are unchanged: no added queries, no changed types.

## Problem and user case

For relation-bound reference fields (migration `087_reference_field_relations`), links live in `_emdash_content_references`. Any column the field had before binding is kept but is no longer authoritative. Fields the migration left unbound still use their columns. `getEmDashEntry(collection, id, { references })` reads relation-bound links. `getEmDashCollection()` cannot. So a page that lists entries together with what they point at (a region index, cards showing an author or client, a schedule showing each session's room and speakers) has two options today:

- **One `getEmDashEntry(..., { references })` per row.** Discussion #3598 reports these workload-specific measurements:
  - 86 queries for a 26-card listing.
  - Around 1,600 queries, and 85–120 s, for a 400-session page.
  - 13,671 queries in a benchmark that loads every session before filtering.
- **A raw query on the internal tables** through `getDb()`. kukutrip.co.il, the Discussion's first site, does this today. It reads tables that can change in any release.

The listing use case was also raised in Discussion #410. This RFC addresses it through the existing explicit `references` selection, without adopting #410's recursive `depth` and without replacing values inside `data`.

## Example

```ts
const { entries } = await getEmDashCollection("routes", {
	limit: 24,
	references: { region: true, related_runs: { limit: 3 } },
});

for (const route of entries) {
	const region = route.references?.region?.entries[0];
	const runs = route.references?.related_runs?.entries; // at most 3 per route, in the editor's order
}
```

## Goals

- `references` on `getEmDashCollection`, in both its cursor and offset filter forms. The selection type and result narrowing are those of `getEmDashEntry` (`ReferenceSelection`, `SelectableReferences`, `SelectedReferences`).
- For each entry, the same result `getEmDashEntry(..., { references })` returns for that entry with the same selection: order, `limit`, `nextCursor`, locale fallback, visibility, and draft behaviour.
- Query count that grows with batches of parents and targets, not with one call per entry.
- No added queries, and no change to inferred types, for calls that don't pass `references`.

## Non-goals

- Filtering or sorting a collection by a reference field (`where: { region: id }`).
- Exposing raw linked ids without loading their targets.
- Nested references (the targets' own references), and `references` on `getEmDashReferences`.
- The MCP half of Discussion #3598: a `references` argument on `content_create` / `content_update`. That is a separate proposal.
- SEO hydration in listings.

## Detailed design

**Selection.** The rules are exactly those of the single-entry resolver (`references/resolve.ts`). A selected field that is unknown, not relation-bound, or mapped to `undefined` is omitted from the result. A valid selected field with no links gets an empty page. An entry without a translation group has no `references` property.

**Both relation directions.** The existing resolver supports parent-side and child-side fields:

- For parent-side fields, links are partitioned by `parent_group` and ordered by `(sort_order, id)`.
- For child-side fields, links are partitioned by `child_group` and ordered by `id` (reverse order is not editor-defined).

Both are always scoped to the field's bound relation.

**Batched link pages.** For each selected field, link pages for every entry on the page are read with `ROW_NUMBER() OVER (PARTITION BY <side> ORDER BY …)`. Each entry gets up to `limit + 1` rows, so `nextCursor` is computed exactly as today. The public target loader already uses this window form on every supported database (`loader.ts`). Parent groups are batched with the existing `chunks(…, SQL_BATCH_SIZE)` helper, which is 50 per batch. That leaves parameter room for the relation, cursor, locale and limit predicates under D1's 100-parameter limit.

**Cursors.** The existing formats are preserved:

- forward `(String(sortOrder), edgeId)`;
- reverse `(edgeId, edgeId)`;
- staged `("staged", targetGroup)`.

A cursor from a listing therefore continues correctly in `getEmDashReferences`, including the transition between a staged and a published selection. As today, pagination is computed before invisible targets are dropped, so a short or empty page can still carry `nextCursor`.

**Targets.** Target groups are de-duplicated across all selected fields and entries, then loaded through `loadEntriesByGroups`, once per target collection and locale/visibility context. This is the loader `getEmDashEntry`'s references use. It applies the existing behaviour:

- locale fallback: the parent's fallback chain, then the lowest available locale;
- row normalization;
- deleted rows excluded, and published-only targets on public reads;
- edit proxies.

Targets stay unhydrated for bylines and taxonomy terms, as they are today.

**Drafts and preview.** Since 1.2 (#3802), a collection read in edit mode shows every entry's draft revision, and a preview token shows only the previewed entry's. Reference reads follow the same per-entry rule:

- For entries with draft access, the batched revision snapshots the loader already reads supply the staged `_references`. A staged empty selection is preserved, and a field with no staged selection falls back to live links.
- Every other entry reads live links.

A preview token must never grant draft-reference access to unrelated entries in the list. Targets are loaded from content rows, not overlaid with their own drafts, which is the single-entry behaviour.

**Caching.**

- The reference selection becomes part of the collection query's request-cache and object-cache keys.
- The selected target collections' object-cache namespaces join the query's dependency set, so editing a target invalidates the listing's snapshot.
- Resolved target row tags and modification times merge into the returned route cache hint. As with `getEmDashEntry`, a route has to apply that hint for its page cache to follow target edits.

**Limits.** Reference pages keep the existing default of 50, clamped to 1–100. Collection queries have no hard page-size cap today, and this RFC does not add one; see Open questions.

## Compatibility and migration

The change is additive. `getEmDashCollection` keeps its `<T, D>` type parameters and the cursor/offset exclusivity of `CollectionFilter`. The selection type is added to both filter variants and carried through `CollectionResult`. Calls without `references` keep today's result type, in which `entry.references` is typed `ReferencePages`, not `{}`. Calls with explicit generic arguments keep compiling. No stored data, migration, REST API or admin change. Rollback is removing the option.

## Security and privacy

No new data is reachable. Targets pass the same visibility filter as on `getEmDashEntry`: published-only on public reads, and deleted rows excluded. Draft links are read only for entries the request already has draft access to. The point that needs tests is that a preview token for one entry must not expose the staged selections of other entries in the same list.

## Performance

Without `references`, nothing changes. With them, each selected field costs one link query per batch of 50 parents, plus one target load per target collection and batch. For example, 500 distinct parents and two fields need about 20 link queries before target loads, against roughly 1,500 for per-row `getEmDashEntry`. The measurement plan: query counts through the existing `db.count` instrumentation and `scripts/query-counts.mjs`, at and across batch boundaries (49, 50, 51 and 500 parents), on SQLite, PostgreSQL and workerd/D1.

Prototype measurement (SQLite, `QueryRecorder`, one selected field): 1 entry → 4 queries (4 per-row); 49 → 4 (148); 50 → 4 (151); 51 → 5 (154); 120 → 6 (361). See the prototype linked from the design PR.

## Failure handling

A failed reference query fails the collection query through its existing `error` channel, as a failed target load does in `getEmDashEntry`. There are no partial results with silently missing pages. Nothing is retried, and nothing is written.

## Verification

- **Parity:** for each entry, results match `getEmDashEntry` with the same selection. Cover:
  - forward and reverse fields;
  - `limit` and `nextCursor`, including continuing a listing cursor in `getEmDashReferences`;
  - staged/live cursor transitions and staged empty selections;
  - locale fallback;
  - published vs edit mode;
  - preview isolation: a preview token for entry A grants no draft links on entry B.
- **Query counts:** growth by batch, asserted with `QueryRecorder` as the existing reference tests do. Zero added queries without `references`.
- **Cache:** editing a target invalidates a listing that selected it, and the route hint carries the target tags.
- **Runtimes:** SQLite, PostgreSQL parity, and workerd/D1 through the existing test setups.
- **Types:** the dedicated reference type suite (`tests/types/references.test-d.ts`) extended to both pagination forms, existing generic call forms, and calls without a selection.
- **Manual:** kukutrip.co.il's three region relations (~700 entries) render the same pages with its raw-SQL workaround removed.

## Rollout and implementation

1. Batched link pages for parent-side fields with public visibility. Behind no flag, because the option is opt-in.
2. Child-side fields and staged/draft selections.
3. Cache keys, dependencies and route hints.
4. Types and docs.

The work can land as one PR or as these slices. Each slice ships with its tests.

## Alternatives

- **Do nothing; sites call `getEmDashEntry` per row.** This is the status quo the Discussion measures.
- **Expose linked ids only, and let sites batch the targets.** Cheaper to build, but every site then re-implements visibility, locale fallback and drafts.
- **Recursive `depth`/`populate` (Discussion #410).** Broader, and it changes `data`. The explicit selection already exists and is typed.

## Drawbacks

A second code path for reference reads has to be kept equal to the single-entry one. The parity tests are what keep it so. Listings get a larger cache key surface.

## Open questions

- Should collection queries get a hard page-size cap, or stricter numeric validation of `limit`, now that a page can fan out into references? Either is a compatibility decision.
- Should the single-entry path be re-implemented on top of the batched one (a page of one), so there is one code path?
