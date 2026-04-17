---
"emdash": minor
---

Adds eager hydration of taxonomy terms on `getEmDashCollection` and `getEmDashEntry` results. Each entry now exposes a `data.terms` field keyed by taxonomy name (e.g. `post.data.terms.tag`, `post.data.terms.category`), populated via a single batched JOIN query alongside byline hydration. Templates that previously looped and called `getEntryTerms(collection, id, taxonomy)` per entry can read `entry.data.terms` directly and skip the N+1 round-trip.

New exports: `getAllTermsForEntries`, `invalidateTermCache`.

Reserved field slugs now also block `terms`, `bylines`, and `byline` at schema-creation time to prevent new fields shadowing the hydrated values. Existing installs that already have a user-defined field with any of those slugs will see the hydrated value overwrite the stored value on read (consistent with the pre-existing behavior of `bylines` / `byline` hydration); rename the field to keep its data accessible.
