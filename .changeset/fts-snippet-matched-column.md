---
"emdash": patch
---

Fixes search snippets quoting the wrong field. An FTS5 index is laid out as `id UNINDEXED, locale UNINDEXED, ...searchable fields`, and `snippet()` was asked for column 2 — whichever field happens to be searchable first, usually the title. A match anywhere else came back as that first field's text with no highlight, so a hit in the body, an artist name, or a tracklist all rendered as the bare title and told the reader nothing about why the entry matched. Snippets now come from the column FTS5 actually matched, and a title match still quotes the title.
