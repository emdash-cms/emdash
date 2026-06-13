---
"@emdash-cms/admin": minor
"emdash": minor
---

Repeater fields support `image` sub-fields with the media picker (#1424)

Repeater rows previously rendered every non-scalar sub-field as a plain text
input, so galleries had to be built from hand-pasted URLs. Image sub-fields
now render the same media-picker UI as top-level image fields (select,
preview, change, remove) and store the same MediaValue shape — legacy string
URLs keep working.

Includes: `image` in the schema-builder sub-field type select, the shared
`ImageFieldRenderer` extracted out of `ContentEditor` for reuse, and the
sub-field type whitelists in core (`REPEATER_SUB_FIELD_TYPES` + the API Zod
enum) extended — the Zod enum also gains the previously missing `url` entry
that the builder already offered.
