---
"emdash": patch
---

Fixes marking a reference field as searchable breaking its collection. Adding such a field to a search-enabled collection failed; after a seed turned search on, creating or saving any entry in that collection failed; and searching the admin's content list failed too. Search now leaves out a reference field bound to a relation.

#### What should I do?

If creating or saving entries in a collection still fails after upgrading and the server log shows `no such column`, open the collection under **Content Types**, untick **Search** and save, then tick it again and save. This rebuilds the collection's search index.
