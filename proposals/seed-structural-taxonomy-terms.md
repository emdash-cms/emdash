---
title: Apply fixed taxonomy terms with the seed schema
type: feature-plan
status: proposed
authors:
  - Chiji1108 (@Chiji1108)
discussion: null
created: 2026-10-22
---

# Apply fixed taxonomy terms with the seed schema

## Problem and user case

Since #1711, seed taxonomy terms are sample data. They are applied only with `includeContent`, so the first-request seed and a setup that skips sample content create the taxonomy with no terms. That is right for a template's example terms. Some sites, though, seed a fixed vocabulary that is part of the site's structure: a clinic's departments, a shop's product lines, a list of stores. Templates and pages link to those slugs, and the site is incomplete without them. Today such a site has to create the terms after setup, with a script or by hand. We hit this migrating a clinic site, where the department taxonomy came up empty in production.

## Proposed behavior

A seed taxonomy can set `termsAreStructure: true`. Its `terms` are then applied with the schema, whatever `includeContent` is: on the first-request seed, when the setup wizard skips sample content, and with `emdash seed --no-content`. Existing terms follow `onConflict`, as other seeded terms do. Taxonomies without the flag behave as today.

```json
{
	"name": "department",
	"label": "Departments",
	"hierarchical": false,
	"collections": ["news"],
	"termsAreStructure": true,
	"terms": [{ "slug": "internal-medicine", "label": "Internal medicine" }]
}
```

## Goals

- A seed can declare terms that exist on every site created from it.
- Template example terms stay sample data by default.

## Non-goals

- Changing the default from #1711.
- Marking individual terms. The flag applies to a taxonomy's whole term list.
- Removing the built-in category and tag taxonomies (#2787).

## Interfaces and compatibility

Adds an optional boolean to `SeedTaxonomy` and documents it in the seed file reference. Seeds without it are unaffected. `SeedApplyOptions.includeContent` keeps its meaning, with the flagged terms as the one exception.

## Errors and edge cases

- Validation rejects a non-boolean value.
- Hierarchical taxonomies apply parents and children together, as today.
- The flag belongs to the taxonomy, like `hierarchical`, so a translation entry takes it from the entry it translates. Validation warns when a translation declares a different value. Reading the flag per entry would apply a translation's terms without their source terms and lose the translation links.
- Seed progress counts flagged terms in its total even without `includeContent`. The setup wizard labels that progress "Sample content". See the open questions.
- The first-request seed runs inside a logged-out request with no query budget. Flagged terms add a few queries per term to that request, so the plan expects a vocabulary of tens of terms, not thousands.

## Verification

- `applySeed` without `includeContent` creates the terms of flagged flat and hierarchical taxonomies, and not the terms of unflagged ones.
- When only the source entry is flagged, a translation entry's terms are created and linked to their source terms.
- Validation rejects a non-boolean flag and warns about a translation that declares its own value.
- Prototype with these tests: [`prototype/seed-structural-terms`](https://github.com/Chiji1108/emdash/commit/5e1b1ab81bbc46425e43fa4ce89e66ccdefa0126).

## Open questions

- Name: `termsAreStructure: true`, or `seedTerms: "always" | "withContent"`?
- `emdash export-seed` cannot know which taxonomies were flagged, so the prototype documents that it never writes the flag. Should the flag be stored on the taxonomy definition so it round-trips?
- Should the first-request seed apply flagged terms through the same budget as setup, or is a documented size expectation enough?
- Should the setup wizard label structural terms separately from "Sample content" in its progress?
