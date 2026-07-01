---
"@emdash-cms/admin": minor
---

Adds taxonomy-backed options to `select` sub-fields inside repeater fields. Setting a sub-field's options to the single sentinel `@taxonomy:<name>` now fills its searchable dropdown with that taxonomy's live terms, so repeater rows can pick from a managed vocabulary that stays in sync as terms are added — instead of hardcoding the list in the collection schema.
