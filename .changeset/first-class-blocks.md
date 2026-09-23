---
"emdash": minor
"@emdash-cms/admin": minor
---

Adds first-class `blocks` fields for ordered, typed page compositions. Define retained block-type versions through the schema API, MCP, or seed files; edit block cards in the admin; and render stored compositions with `<Blocks value components fallback>` from `emdash/ui`.

Generated collection types include each retained block version, and `defineBlockComponents<T>()` type-checks that a component map covers every generated `_type`. Image, file, repeater-image, and Portable Text media inside blocks participate in normalization, MIME validation, usage tracking, and cleanup protection.

Deploy renderer support before activating a breaking block-type version. Existing versions remain available for drafts, revisions, and stored content, and migrating a stored block to a new version requires explicit `migrateBlocks: true` intent.

Sites upgrading from a release older than 0.39 must deploy 0.39 first and upgrade every runtime before creating a blocks field. The 0.39 unknown-field protection prevents an older runtime in a rolling deployment or rollback from overwriting block JSON.
