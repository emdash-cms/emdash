---
"emdash": patch
---

Fixes taxonomy-filtered collection listings reading the entire collection on SQLite/D1 when the term is selective. Such listings now seek the matching entries directly, cutting D1 rows-read from tens of thousands to the page size.
