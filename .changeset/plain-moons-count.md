---
"emdash": minor
---

Adds a `fields` option to `getEmDashCollection`, which reads only the named content fields instead of every column, as the accepted feature plan `proposals/collection-field-projection.md` describes.

List queries read each entry's whole body to render a card or an archive row. On a 1,891-entry collection averaging 8.8 KB of body, a page reading 93 rows to draw 26 cards moved about 800 KB to render about 40 KB of markup.

System fields, sort columns, taxonomy terms, bylines and SEO are still returned, and in preview a draft supplies only the requested fields. Without `fields`, nothing changes. A projected entry is partial: an unrequested field is absent from `entry.data`, and with generated collection types `entry.data` is narrowed to the requested fields, so reading another one is a type error. An empty list, a malformed name, a name that is not a field of the collection, and a `reference` field bound to a relation throw before any query runs.
