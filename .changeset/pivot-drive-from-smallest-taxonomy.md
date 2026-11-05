---
"emdash": patch
---

Speeds up `getEmDashCollection()` listings on SQLite and D1 that filter by two or more taxonomies and no content fields. The listing now starts from the taxonomy with the fewest entries instead of the one written first in `where`, so a broad taxonomy listed first no longer slows it down.
