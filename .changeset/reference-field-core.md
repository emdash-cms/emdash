---
"emdash": minor
---

Reference fields are now storage-less: they no longer add a TEXT column to a collection's table, and their values are stored as content-reference edges instead. Selections ride in the content create/update body under a `references` key and are written atomically with the entry in a single transaction, and the content GET hydrates them alongside SEO and bylines. Each resolved reference carries a display title sourced from the referenced entry's `title` (then `name`) field, so backlinks and picked entries show a readable label rather than a slug. A reference field's config (relation, target collection, multiple) flows through the admin manifest, and its backing relation definition is created and removed together with the field. Seed files that use a reference field now apply its `$ref:` value as an edge (the seed shape is unchanged); the relation is created from the field's target collection. Existing reference columns keep their data but are no longer written.
