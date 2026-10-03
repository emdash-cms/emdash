---
"@emdash-cms/plugin-forms": minor
---

Adds an optional `contentMapping` form setting. When a form has one, each successful submission also creates a draft entry in the chosen collection. Each mapped form field can be converted on the way in (`portableText`, `string`, `number` or `date`), and `metadata` sets fixed values on every entry. The entry's slug comes from its `title` or `name` field, as it does for entries created in the admin.

The mapping is checked when the form is saved. The collection and every mapped field must exist, each form field and `metadata` value must produce a value its target field accepts, a field cannot be set by both a mapping and `metadata`, and every required field in the collection must be covered by a non-empty `metadata` value or a required form field that is always shown. File fields cannot be mapped. The submission is always kept in the forms inbox, even if creating the entry fails.

The plugin now declares the `content:write` and `schema:read` capabilities. They are used only by forms with a `contentMapping`.
