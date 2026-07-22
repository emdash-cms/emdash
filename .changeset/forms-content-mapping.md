---
"@emdash-cms/plugin-forms": minor
---

Adds an optional `contentMapping` form setting that creates a draft content entry in a target collection from each successful submission, with per-field transforms (`portableText`, `string`, `number`, `date`), an optional `slugFrom` field, and constant `metadata` fields. Mappings are validated against the target collection when the form is saved — including that every required collection field is covered — and the submission is always stored in the forms inbox even if content creation fails.
