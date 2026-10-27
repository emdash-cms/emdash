---
"@emdash-cms/admin": patch
"emdash": patch
---

Fixes entry slugs being generated from a field named `title` instead of the collection's configured title field. In a collection whose `titleField` is `name` and which also has a `title` field (a person's job title, say), typing in the editor now fills the slug from the name, and entries created through the API without a slug get one from the name too, so two people with the same job title no longer collide with `SLUG_CONFLICT`. Collections without a `titleField` keep the previous `title`, then `name`, order.
