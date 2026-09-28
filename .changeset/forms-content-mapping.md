---
"@emdash-cms/plugin-forms": minor
---

Adds an optional `contentMapping` form setting. When a form has one, each successful submission also creates a draft entry in the chosen collection. Each mapped form field can be converted on the way in (`portableText`, `string`, `number` or `date`), and `metadata` sets fixed values on every entry. The entry's slug comes from its `title` or `name` field, as it does for entries created in the admin.

The mapping is checked when the form is saved. The collection and every mapped field must exist, and every required field in the collection must be covered by a required form field or a `metadata` value. The submission is always kept in the forms inbox, even if creating the entry fails.

The plugin now declares the `content:write` and `schema:read` capabilities. They are used only by forms with a `contentMapping`.
