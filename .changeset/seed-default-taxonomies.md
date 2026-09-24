---
"emdash": patch
---

Fixes seeds that declare `category` or `tag` losing their labels and collection assignments. Every new database starts with built-in versions of these two taxonomy definitions, and seeding skipped them as existing. Until a site edits them, the built-in definitions are now replaced by the seed's in every `onConflict` mode, including `--on-conflict error`, which no longer fails on them. Edited definitions are still kept by the default `skip` mode. Running `emdash seed` against an existing site that never edited these two taxonomies now applies the seed's labels, collections, and hierarchy to them. `applySeed()` results include `taxonomies.skipped`, `emdash seed` prints it, and the automatic first-boot seed logs a warning when it keeps any existing taxonomy definitions.
