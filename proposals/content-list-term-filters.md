---
title: Filter the content list by taxonomy term
type: feature-plan
status: proposed
authors:
  - Noah Eisenbruch (@eisenbruch)
discussion: https://github.com/emdash-cms/emdash/discussions/3055
created: 2026-10-10
---

# Filter the content list by taxonomy term

This plan records, retrospectively, the design of #3046, which was opened on September 10, 2026, before this process existed. The implementation is a working prototype of everything below.

## Problem and user case

A collection's content list can be filtered by status, author, byline, date range, free text and any indexed custom field. It cannot be filtered by a taxonomy term, in the admin or over the API.

An editor on a site organized by taxonomies cannot ask the admin "show me every entry with this term". Our site has about 2,000 articles across 64 topics and 9,700 directory listings across 41 business types, and that question is answered today through the public site or the MCP server instead of the screen editors work in.

The workaround is an indexed `select` field in place of the taxonomy. It gives up the shared vocabulary, renaming, term pages and hierarchy that a taxonomy exists for.

The gap is also hard to notice over the API. `contentListQuery` strips parameters it does not recognize, so a guess such as `?taxonomy=topics&term=rodeo` returns the complete, unfiltered list with a 200.

## Proposed behavior

### API

`GET /_emdash/api/content/{collection}` accepts a new optional query parameter, `termFilters`: a JSON object keyed by taxonomy name, each value an array of term slugs.

```
?termFilters={"topics":["rodeo","polo"],"places":["kentucky"]}
```

An entry matches a key when it carries any of that key's slugs, and must match every key. That is OR within a taxonomy and AND across taxonomies, which is how the controls read: two terms of one taxonomy widen a search, two taxonomies narrow it.

The filter applies to both the page query and the count, so `total` and cursor pages agree. It combines with every existing filter, including `fieldFilters`.

`termFilters` is a sibling of `fieldFilters`, not an extension of it. Terms are not columns, and a separate parameter means a field and a taxonomy that share a name cannot collide.

### Admin

The content list shows one dropdown per taxonomy applied to the collection, beside the existing status and byline filters. Each lists "All <taxonomy>" and then the taxonomy's terms. A hierarchical taxonomy is flattened depth-first and indented, matching the term picker in the entry editor.

Nothing is configured per site. A collection with no taxonomy shows nothing new, and a collection that gains a taxonomy gains its filter. Terms load per taxonomy, and only for the taxonomies on screen.

## Goals

- Filter a collection's content list by one or more terms, in the admin and over the REST API.
- Keep `total` and pagination consistent with the filtered list.
- Never return a plausible, unfiltered list for a filter that could not be applied.
- Require no per-site configuration.

## Non-goals

- Sorting the list by a term.
- Selecting more than one term of a taxonomy in the admin. The API parameter already takes an array, so this can follow without an API change.
- An MCP `content_list` parameter. It can reuse the same repository filter in a later change.
- Making `contentListQuery` reject unknown query parameters. See "Open questions".
- Any change to how terms are stored or assigned.

## Interfaces and compatibility

- **REST API:** one new optional query parameter, `termFilters`, on the content list route. Requests that do not send it behave exactly as before.
- **Repository:** `FindManyOptions.where` gains an optional `termFilters` field, read by `findMany` and by the count.
- **Admin client:** `fetchContentList` accepts `termFilters`. "No selection" is the absence of a key, never an empty array.
- **Stored data, migrations, configuration and plugin surface:** none.

The query is one `EXISTS` subquery per key against `content_taxonomies`. Two details of that table are relied on, and both match nothing instead of raising an error when got wrong:

- `content_taxonomies.entry_id` holds the entry's `translation_group`, not its `id`.
- It points at `taxonomies.translation_group`, so a term matches through any of its locale variants unless the list is locale-scoped.

## Errors and edge cases

A filter that silently matches everything returns a complete, plausible list with a 200, which is the hardest kind of wrong answer to notice. Every choice below follows from that.

- A taxonomy that is not applied to the collection, or does not exist, is a `VALIDATION_ERROR` naming the taxonomy. It is not an empty result and not a no-op.
- A slug that matches no term matches no entries. It does not fall back to "no filter". This mirrors the existing byline filter's handling of an empty id set.
- An empty array for a taxonomy is rejected by the API schema: a taxonomy filter needs at least one slug. Below the schema, the repository treats an empty array as matching nothing, so a caller that bypasses the route cannot get an unfiltered list either.
- Malformed JSON is a validation error.
- Limits, bounded the same way as indexed field filters because both become operands in one statement: at most 10 taxonomies, a shared budget of `SQL_BATCH_SIZE` (50) slugs across all of them, taxonomy names of at most 63 characters matching `^[a-z][a-z0-9_]*$`, slugs of at most 200 characters, and a raw parameter of at most 8,192 characters.

## Verification

Repository tests, which seed `content_taxonomies` directly to pin the two junction details above:

- OR within a taxonomy.
- AND across taxonomies.
- An unknown slug matches nothing, and so does an empty slug list at the repository level.
- `total` stays stable across cursor pages.
- A term filter combined with an indexed field filter.

Schema and handler tests: the limits above, malformed JSON, and the `VALIDATION_ERROR` for a taxonomy not applied to the collection.

Admin component tests: a collection with no taxonomy renders no new control, a selection is sent as `termFilters`, and "Clear filters" is offered for a term selection alone and removes the key.

Manual verification against a running site: an unfiltered list, a filtered list, and a filter naming an unknown taxonomy, each checked for both `items` and `total`.

## Open questions

- Should `contentListQuery` reject unknown query parameters? A strict schema would turn every mistyped filter into an error instead of an unfiltered list, but it would also reject any caller that sends an extra parameter today. It is left out of this plan and could be its own small change.
