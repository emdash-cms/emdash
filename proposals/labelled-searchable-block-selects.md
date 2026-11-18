---
title: Labelled searchable selections in native blocks
type: rfc
status: proposed
authors:
  - Baran Özdemir (@baranozdemir1)
champion: Baran Özdemir (@baranozdemir1)
sponsor: null
discussions:
  - https://github.com/emdash-cms/emdash/discussions/4951
created: 2026-11-18
---

# Labelled searchable selections in native blocks

## Summary

Add opt-in display labels and visible search to native block select fields, including select sub-fields inside block repeaters. Preserve their existing string enum values.

Related issue: https://github.com/emdash-cms/emdash/issues/4949

## Problem and user case

A Page can compose independent FAQ blocks that select canonical records. Editors recognize question titles; integrations need immutable identifiers. Block selects currently use the same string for both purposes. An ordinary repeater's searchable picker does not provide this native Blocks schema contract.

## Example

The following sub-field stores `faq_shipping` while showing a question title.

```ts
{
  slug: "faq",
  label: "FAQ",
  type: "select",
  required: true,
  options: ["faq_shipping", "faq_returns"],
  optionLabels: {
    faq_shipping: "Where does shipping operate?",
    faq_returns: "How do returns work?"
  },
  searchable: true
}
```

For a top-level block select, put the presentation metadata in its `validation` object alongside `options`.

## Goals

- Search and select by display text inside native Blocks.
- Preserve the string value through label changes and save/reload.
- Preserve native repeater ordering, keyboard operation and publication controls.

## Non-goals

- Native block relations or automatic content queries.
- Relation backlinks, referential integrity or translation-group resolution.
- An application-specific FAQ type, renderer or plugin.
- A remote search API or automatic synchronization of published choices.

## Detailed design

Keep `options: string[]` unchanged. Add optional `optionLabels?: Record<string, string>` and `searchable?: boolean` to block-select presentation metadata. Block repeater sub-fields carry the same properties. Labels must belong to declared option values, contain nonblank text and be at most 500 characters. Missing labels fall back to the corresponding value; duplicate labels are allowed because identity is the value.

REST validation and BlockTypeRegistry validation must retain and validate both properties. Native block-field normalization must carry them into the field descriptor. When searchable is true, ContentEditor uses its existing Kumo Combobox with separate item label/value functions and equality by value. Otherwise, retain the existing Select behavior. Ordinary collection field REST contracts remain unchanged.

Use Lingui for search, empty-state and icon-button labels. Preserve the enclosing field's accessible name and read-only state. Forward native input props, events and refs. Apply quiet-input classes to the actual input using the render API; its wrapper must not introduce padding or a competing height. Retain logical inline-end padding for the controls. Keyboard navigation, clearing, no-match handling and Escape must retain native Combobox semantics.

## Design decisions

The first release is block-specific and API-defined. Ordinary collection selects and their REST contracts retain their existing behavior. Adding label/search configuration controls to the block-type designer is deferred; editing an existing definition must preserve this metadata when unrelated settings change.

Omitting `searchable` or setting it to false retains the existing Select. Labels apply in both presentation modes, fall back to the option value when absent, and remain plain display text. Renaming a label never rewrites the stored option value. Duplicate labels remain distinct selections by value; adding secondary record metadata is outside this scope.

## Related designs

The implemented [Blocks field redesign](https://github.com/emdash-cms/emdash/blob/main/proposals/blocks-field-redesign.md) remains authoritative for row structure, quiet controls, repeater actions and publication behavior. This RFC adds opt-in select presentation metadata within that design; it does not replace its layout rules or introduce field grouping.

[#1657](https://github.com/emdash-cms/emdash/pull/1657) covers ordinary repeater search. Its behavior is retained; this RFC covers the native Blocks descriptor path and separate labels for string values. The pending [collection-field projection RFC #4849](https://github.com/emdash-cms/emdash/pull/4849) concerns read-query projection, not select editing or option identity, and is unaffected. No amendment or supersession of these designs is proposed.

## Compatibility and migration

This is additive and opt-in. Stored content remains a string enum; type generation and value validation retain their existing meaning. Label/search updates are compatible schema changes. Removing a stored option remains a breaking schema change under the existing version contract. Existing schemas and values require no migration. Integrations converting old slug values to IDs must explicitly migrate their own block versions and preserve live/draft state; that application migration is outside this proposal.

## Security and privacy

Existing schema permissions and CSRF enforcement remain authoritative. Labels are text, not HTML. The picker uses choices already present in the schema and makes no content queries. Integrators must avoid exposing private record titles through schema choices. This proposal adds no record-level authorization or new reference permissions.

## Performance

Search runs over the existing in-memory option list. No server queries are added to logged-out rendering or publication. Very large option sets need separate remote-search design; this proposal does not add pagination or claim unrestricted scale.

## Failure handling

Reject invalid labels, labels for undeclared values and nonboolean search flags at schema validation. Existing required/enum checks still govern saved values. An unknown selected value must not be silently rewritten by merely opening the editor. Integrators retain choices that they still need to edit and own any publication/withdrawal checks.

## Verification

Cover REST metadata retention, registry validation, unchanged string enums, duplicate labels with distinct values, compatible label changes and breaking value removal. Include metadata round trips when an existing block definition is edited through the designer, and labels on non-searchable selects. Browser checks cover top-level and nested selects, filtering, pointer/keyboard selection, clearing, read-only state, no matches, Escape, save/reload and independent block order. Check both light/dark themes and narrow viewports. Verify that input and wrapper align, focus remains visible, labels are accessible and the publication sidebar remains native.

[Source/test diff and screenshots](https://github.com/baranozdemir1/emdash/tree/codex/block-select-review-assets/contribution-assets/block-select) are available in the fork.

The local prototype has passed 33 affected SQLite tests, core/admin types and targeted lint; reference-site browser/API checks passed. PostgreSQL/D1, the full upstream build and full upstream lint/type/test suites are not yet acceptance evidence.

## Rollout and implementation

The linked Ideas Discussion establishes the user case; this PR is ready for design review. A human Maintainer sponsor is requested, not assumed. Merge the accepted design before opening an implementation PR. Publish core/admin together with a minor changeset. No database migration is needed. Review the prototype against current main before implementation submission; its current tested runtime is the 1.5.0 tag.

## Alternatives

Use human-readable titles as stored values, at the cost of rename stability. Use slugs/IDs as both labels and values, at the cost of editor usability. Store true block references, which requires a substantially broader schema/publication design. Use a custom editor, which loses the existing native Blocks flow.

## Drawbacks

Two optional schema properties become a maintained public contract. Applications still need to refresh labels and enforce record publication rules. Duplicate display titles can be ambiguous even though values remain distinct.

## Review and acceptance

The public contract and first-release scope are specified above. A human Maintainer sponsor, independent Maintainer support and Project Lead acceptance remain external review requirements. The proposal remains `proposed`; `accepted` must not be set before those requirements and the normally seven-day public review period are satisfied. The review-period start and any extension are determined by the upstream Maintainers, not asserted by this contribution.

The PR's CLA check also requires the contributor's personal legal acceptance. No agent signature, sponsorship or reviewer approval substitutes for that acceptance.
