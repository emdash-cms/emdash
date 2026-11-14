---
title: Leave the default taxonomies to the seed
type: rfc
status: proposed
authors:
  - Kevin Kyburz (@swissky)
champion: Kevin Kyburz (@swissky)
sponsor: Kevin Kyburz (@swissky)
discussions:
  - https://github.com/emdash-cms/emdash/discussions/4622
created: 2026-11-03
---

# Leave the default taxonomies to the seed

## Summary

New EmDash databases stop keeping the `category` and `tag` taxonomy definitions that migration 006 inserts. The seed file decides which taxonomies a new site has. Sites without a seed file still get Categories and Tags, because EmDash's built-in default seed declares both. Existing sites keep every taxonomy they have.

## Problem and user case

Migration 006 inserts `category` and `tag` into every database, scoped to a `posts` collection. A site whose seed defines no `posts` collection still lists both under Taxonomies in the admin. They attach to no collection, no editor screen offers them, and nothing explains where they came from.

[#2787](https://github.com/emdash-cms/emdash/issues/2787) reports this for a site with `news`, `events`, `documents`, `groups` and `pages` collections and its own `news_category` and `doc_category` taxonomies. The admin shows five taxonomies, two of them unusable. The `marketing` and `marketing-cloudflare` templates hit the same case: their seeds declare no taxonomies, and new sites built from them show both entries anyway.

Current workarounds:

- Delete both taxonomies in the admin after setup. **Delete taxonomy** exists since [#3247](https://github.com/emdash-cms/emdash/pull/3247), but every adopter of a template has to do it by hand.
- Tell adopters to ignore the two entries.

A template can't remove them during setup, because the seed format can only create and update definitions.

## Example

A seed with one collection and one taxonomy:

```json title="seed/seed.json"
{
	"collections": [{ "slug": "news", "label": "News", "fields": [] }],
	"taxonomies": [
		{
			"name": "news_category",
			"label": "News categories",
			"hierarchical": true,
			"collections": ["news"]
		}
	]
}
```

| Site                                 | Taxonomies after setup today              | Taxonomies after setup with this RFC      |
| ------------------------------------ | ----------------------------------------- | ----------------------------------------- |
| New site with the seed above         | `news_category`, `category`, `tag`        | `news_category`                           |
| New site without a seed file         | `category`, `tag` (from the default seed) | `category`, `tag` (from the default seed) |
| New site from the `blog` template    | `category`, `tag` (from its seed)         | `category`, `tag` (from its seed)         |
| Existing site, after updating EmDash | unchanged                                 | unchanged                                 |

## Goals

- A new site has exactly the taxonomies its seed declares.
- Sites without a seed file keep getting Categories and Tags.
- No existing site loses a taxonomy definition, term or assignment.
- Templates and demos that declare `category` and `tag` in their seed behave as they do today.

## Non-goals

- Hiding taxonomies whose `collections` name no existing collection. That is a separate admin behavior and would also apply to sites that chose such a setup on purpose.
- Letting seed files delete taxonomies.
- Changing how `applySeed` treats a seed that declares `category` or `tag`.

## Detailed design

### Migration

A new migration removes the two built-in definitions when all of these hold:

1. `_emdash_collections` has no rows. Migrations run before the setup wizard and the first-boot seed, so on a new database this is true when the migration runs. On a database that has been set up, it is false and the migration does nothing.
2. The definition still holds the values migration 006 inserted: its `taxdef_category` or `taxdef_tag` id, label, singular label, hierarchy and `collections`. `isUntouchedBuiltInTaxonomyDef` in `seed/apply.ts` performs this check at runtime; the migration repeats the comparison in SQL because migrations don't import runtime code.
3. No row in `taxonomies` uses the definition's `name`.

The migration is one `DELETE` on `_emdash_taxonomy_defs` with the three conditions in its `WHERE` clause. Running it again after a lost response deletes nothing new, so it is safe to restart. `down` is a no-op, like other data migrations.

Migration 006 stays unchanged, since shipped migrations are immutable.

### Seeds

The seed becomes the only source of taxonomy definitions on a new site:

- The default seed in `seed/default.ts` already declares `category` and `tag` for its `posts` collection. Sites without a seed file get them through the setup wizard or the first-boot seed, with the same labels, hierarchy and collections as today.
- Seeds that declare `category` or `tag` create them as new definitions. The replacement of untouched built-ins added in [#3355](https://github.com/emdash-cms/emdash/pull/3355) stays for databases created before this change.
- Seeds that declare neither leave the site without them.

### Other callers

- `emdash init` runs the migrations before a template's `schema.sql` or seed, so it follows the same rule.
- A WordPress import into a new site whose seed lacks `category` or `tag` reports them under `missingTaxonomies` and skips their terms, which is the current behavior for any missing taxonomy. See the open questions.

## Compatibility and migration

- Existing sites: no change. The migration's first condition is false on every site that has been set up.
- A database that was migrated but never set up, for example an install that stopped at the setup wizard, loses the two untouched, empty definitions. Its setup then applies the seed, which recreates them when the seed or the default seed declares them.
- Code that expects `category` and `tag` on every new site breaks when the site's seed doesn't declare them. `getTaxonomyTerms()` already returns an empty list for a missing taxonomy, so pages still render, but a template relying on the built-ins has to add them to its seed. The changeset names this and shows the seed entries to add.
- Rollback: reinstalling the previous release doesn't restore the definitions. A site that needs them creates them in the admin, through the API, or from a seed.

This changes a default for new sites, so it ships in a minor release.

## Security and privacy

No additional security or privacy surface. The migration deletes rows only under the conditions above, takes no input and runs with the existing migration privileges.

## Performance

No runtime effect. The migration adds one `DELETE` with three subqueries, run once per database. Logged-out routes and query counts are unchanged.

## Failure handling

The migration is a single statement. If it fails, the runner reports the error like any other migration and retries on the next start. A single statement can't partially complete, and its conditions make a retry safe.

## Verification

- Migration tests on SQLite, D1 (workerd suite) and PostgreSQL:
  - a new database ends without `category` and `tag`;
  - a database with a collection keeps both;
  - a database without collections but with an edited `category`, or with `tag` terms, keeps that definition;
  - running the migration twice gives the same result.
- Seed tests: the default seed still produces `category` and `tag` with today's values; a seed without them leaves none; a seed declaring them with other labels gets those labels.
- Setup and first-boot seed integration tests for a seed without taxonomies.
- Manual check of the `marketing` template: no Taxonomies entries in the admin after setup.
- Existing tests that assume the built-ins on a bare test database are updated to declare the taxonomies they use.

## Rollout and implementation

One implementation pull request: the migration, its registration in `runner.ts`, tests, docs and a changeset. In `themes/seed-files.mdx`, the conflict-behavior exception for the built-in `category` and `tag` definitions is reworded to apply only to databases created before this change, and the page states that a new site gets only the taxonomies its seed declares. The page on connecting an existing project already says Categories and Tags come from the built-in starting model and stays accurate.

## Alternatives

- **Hide taxonomies whose collections don't exist** (option 2 in #2787). Smaller change, but it hides data instead of not creating it, would also hide taxonomies a site set up that way on purpose, and leaves the two definitions in exports and the API.
- **Let seeds delete taxonomies.** Every template that doesn't want the built-ins would have to remove them explicitly, and the seed format would gain a destructive operation.
- **Rely on Delete taxonomy in the admin** (#3247). Works today, but leaves a manual step for every adopter of every template without `posts`.

## Drawbacks

- A new site whose seed omits `category` and `tag` no longer gets them, which can surprise someone who expected them from earlier versions.
- Tests and fixtures that relied on the built-ins existing in a bare database need updates.
- The seed code keeps the #3355 path for older databases, so there are two ways the built-ins can come into being for some time.

## Open questions

- Should the WordPress importers create `category` and `tag` when the source has categories or tags and the site lacks the definitions, as the plugin importer already does for custom taxonomies?
- Is `_emdash_collections` being empty the right signal for a new database, or should the migration also check `emdash:setup_complete`?
