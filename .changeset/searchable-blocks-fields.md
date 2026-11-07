---
"emdash": minor
---

Adds support for marking a `blocks` field as `searchable`, so text inside a page's blocks is found by full-text search. Portable Text content inside blocks (including image alt and caption, and code blocks) is indexed; a page built only from blocks can now be found by searching for words in its body.

Set `searchable: true` on the field. Toggling it on for an existing collection rebuilds the index from current content:

```ts
{ slug: "layout", type: "blocks", searchable: true, validation: { allowedTypes: ["prose"] } }
```

Plain string and text sub-fields such as headings or labels are not indexed unless their sub-field slug happens to be `text`, `alt`, `caption` or `code`; a schema-aware key list is a possible follow-up. `extractSearchableFields()` also takes an optional `fieldTypes` map so it can read `blocks` fields.
