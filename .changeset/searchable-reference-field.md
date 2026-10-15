---
"emdash": patch
---

Fixes marking a reference field as searchable breaking its collection. Adding such a field to a search-enabled collection failed, after a seed every new entry in that collection failed with `no such column`, and the admin's content list search failed the same way. The `searchable` flag now has no effect on a reference field.

#### What should I do?

If new entries in a collection already fail with `no such column` after upgrading, turn its **Search** support off and on again in the content type editor to rebuild its search index.
